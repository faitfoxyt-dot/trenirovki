// Функция бота. Её раз в час будит расписание из 0002_bot.sql.
// Что и когда отправлять, решает база (bot_outbox); здесь только отправка в Telegram.
// Токен берётся из секретов Edge Functions: TELEGRAM_BOT_TOKEN. В коде его нет.
//
// Supabase пускает сюда только с публичным ключом (apikey), его передаёт расписание (0003).
// Лишний вызов безопасен: база отдаёт каждое сообщение один раз, дублей не будет.

import { createClient } from 'npm:@supabase/supabase-js@2';

type Outgoing = { key: string; chat_id: number; topic: number | null; msg: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async () => {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!token) return json({ error: 'Нет секрета TELEGRAM_BOT_TOKEN' }, 500);
  if (!url || !serviceKey) return json({ error: 'Нет SUPABASE_URL или SUPABASE_SERVICE_ROLE_KEY' }, 500);

  const db = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await db.rpc('bot_outbox');
  if (error) return json({ error: error.message }, 500);

  const results = [];
  for (const m of (data ?? []) as Outgoing[]) {
    const payload: Record<string, unknown> = { chat_id: m.chat_id, text: m.msg };
    // Тема 1 — общая: в неё пишут без номера темы.
    if (m.topic && m.topic !== 1) payload.message_thread_id = m.topic;

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const tg = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (tg.ok) {
      const mark = await db.rpc('bot_mark_sent', { p_key: m.key });
      results.push({ key: m.key, sent: true, marked: !mark.error });
    } else {
      // Не отмечаем: попробуем снова через час.
      results.push({ key: m.key, sent: false, error: tg.description });
    }
  }
  return json({ sent: results });
});
