// Функция бота. Её будят два расписания:
// — раз в час (0003, тело {}): итоги дня и напоминания. Что и когда отправлять, решает база (bot_outbox).
// — раз в минуту (0016, тело {"poll": true}): забрать новые видео из группы (getUpdates) и отдать их
//   в bot_video. База решает, засчитать ли подход; здесь только реакция 🫡/👀 или ответ в группе.
// Токен берётся из секретов Edge Functions: TELEGRAM_BOT_TOKEN. В коде его нет.
//
// Supabase пускает сюда только с публичным ключом (apikey), его передают расписания.
// Лишний вызов безопасен: база отдаёт каждое сообщение и каждое видео один раз.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

type Outgoing = { key: string; chat_id: number; topic: number | null; msg: string };
type Tg = { ok: boolean; result?: any; description?: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!token) return json({ error: 'Нет секрета TELEGRAM_BOT_TOKEN' }, 500);
  if (!url || !serviceKey) return json({ error: 'Нет SUPABASE_URL или SUPABASE_SERVICE_ROLE_KEY' }, 500);

  const tg = async (method: string, payload: Record<string, unknown>): Promise<Tg> => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  };

  const db = createClient(url, serviceKey, { auth: { persistSession: false } });
  const body = await req.json().catch(() => ({}));
  if (body?.poll) return json(await poll(db, tg));

  const { data, error } = await db.rpc('bot_outbox');
  if (error) return json({ error: error.message }, 500);

  const results = [];
  for (const m of (data ?? []) as Outgoing[]) {
    const payload: Record<string, unknown> = { chat_id: m.chat_id, text: m.msg };
    // Тема 1 — общая: в неё пишут без номера темы.
    if (m.topic && m.topic !== 1) payload.message_thread_id = m.topic;

    const sent = await tg('sendMessage', payload);
    if (sent.ok) {
      const mark = await db.rpc('bot_mark_sent', { p_key: m.key });
      results.push({ key: m.key, sent: true, marked: !mark.error });
    } else {
      // Не отмечаем: попробуем снова через час.
      results.push({ key: m.key, sent: false, error: sent.description });
    }
  }
  return json({ sent: results });
});

// Видео из группы: забираем новые сообщения, видео отдаём базе, ставим реакцию или отвечаем.
async function poll(db: SupabaseClient, tg: (m: string, p: Record<string, unknown>) => Promise<Tg>) {
  const { data: st, error } = await db.rpc('bot_poll_state');
  if (error) return { error: error.message };

  // Раз в 15 минут проверяем, админ ли бот в группе: без этого Telegram не показывает ему чужие видео.
  let admin: boolean | null = null;
  if (st.check_admin) {
    const me = await tg('getMe', {});
    if (me.ok) {
      const member = await tg('getChatMember', { chat_id: st.chat_id, user_id: me.result.id });
      if (member.ok) admin = ['administrator', 'creator'].includes(member.result.status);
    }
  }

  const upd = await tg('getUpdates', { offset: st.offset, timeout: 0, allowed_updates: ['message', 'edited_message'] });
  if (!upd.ok) {
    await db.rpc('bot_polled', { p_offset: st.offset, p_seen: false, p_admin: admin });
    return { error: upd.description };
  }

  let next = st.offset;
  let seen = false;
  const done = [];
  for (const u of upd.result ?? []) {
    next = Math.max(next, u.update_id + 1);
    const m = u.message ?? u.edited_message;
    if (!m || m.chat?.id !== st.chat_id) continue;
    seen = true;
    const isVideo = m.video || m.video_note || m.animation || m.document?.mime_type?.startsWith('video/');
    if (!st.on || !isVideo || m.from?.is_bot) continue;

    const { data: act, error: err } = await db.rpc('bot_video', { p: {
      chat_id: m.chat.id, message_id: m.message_id, user_id: m.from?.id, username: m.from?.username ?? '',
      caption: m.caption ?? '', date: m.date,
    } });
    if (err) { done.push({ id: m.message_id, error: err.message }); continue; }
    if (act?.react !== undefined) await react(tg, m.chat.id, m.message_id, act.react);
    if (act?.reply) {
      const payload: Record<string, unknown> = { chat_id: m.chat.id, text: act.reply,
        reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } };
      if (m.is_topic_message && m.message_thread_id) payload.message_thread_id = m.message_thread_id;
      await tg('sendMessage', payload);
    }
    done.push({ id: m.message_id, ...act });
  }
  await db.rpc('bot_polled', { p_offset: next, p_seen: seen, p_admin: admin });

  // Подходы, принятые позже (друг вписал повторы после видео): ставим 🫡 под видео.
  const { data: late } = await db.rpc('bot_reactions');
  for (const r of late ?? []) await react(tg, r.chat_id, r.message_id, r.react);

  return { videos: done, late: (late ?? []).length, admin };
}

// Пустая строка — убрать реакцию бота.
const react = (tg: (m: string, p: Record<string, unknown>) => Promise<Tg>, chat: number, msg: number, emoji: string) =>
  tg('setMessageReaction', { chat_id: chat, message_id: msg, reaction: emoji ? [{ type: 'emoji', emoji }] : [] });
