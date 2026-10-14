-- Трекер тренировок · v2: Telegram-бот.
-- Итог закрытого дня — в тему «Итоги» после 00:00, вечернее напоминание атлету,
-- если день не заполнен. Применять один раз целиком в Supabase → SQL Editor.
-- Токена бота здесь нет: он лежит в секретах Edge Functions (TELEGRAM_BOT_TOKEN).

-- ───────────── Настройки ─────────────

alter table public.profiles
  add column tg_username text,                    -- без @, для упоминания в напоминании
  add column notify boolean not null default true; -- false = бот про этого атлета молчит

-- Тестовый атлет (почта с +test) боту не нужен.
update public.profiles p set notify = false
from auth.users u where u.id = p.id and u.email like '%+test@%';

create table public.bot_settings (
  id            int primary key default 1 check (id = 1),
  enabled       boolean not null default true,
  chat_id       bigint not null,
  results_topic int,                              -- тема «Итоги»; null или 1 = общая
  remind_hour   int not null default 21 check (remind_hour between 12 and 23)
);
-- Группа и тема «Итоги» из ссылок t.me/c/3987236163/…
insert into public.bot_settings (id, chat_id, results_topic) values (1, -1003987236163, 3);

-- Что бот уже отправил, чтобы не повторяться.
create table public.bot_log (
  key     text primary key,                       -- 'hello', 'summary:<атлет>:<дата>', 'remind:<атлет>:<дата>'
  sent_at timestamptz not null default now()
);

alter table public.bot_settings enable row level security;
alter table public.bot_log enable row level security;
create policy "админ читает" on public.bot_settings
  for select to authenticated using (public.is_admin());
create policy "админ меняет" on public.bot_settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
-- bot_log читает и пишет только функция бота (service role).

-- ───────────── Тексты ─────────────

create function public.bot_day_title(p_date date) returns text
language sql immutable as $$
  select (array['Пн','Вт','Ср','Чт','Пт','Сб','Вс'])[extract(isodow from p_date)::int]
         || ', ' || to_char(p_date, 'DD.MM')
$$;

-- Итог одного дня атлета. null — если про этот день писать нечего.
create function public.bot_summary_text(p_athlete uuid, p_date date) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  p     profiles;
  d     days;
  m     morning_checks;
  ex    jsonb;
  reps  text;
  vids  int;
  done  int;
  lines text[] := '{}';
begin
  select * into p from profiles where id = p_athlete;
  select * into d from days where athlete_id = p_athlete and date = p_date;
  select * into m from morning_checks where athlete_id = p_athlete and date = p_date;

  lines := lines || ('Итог · ' || bot_day_title(p_date) || ' · ' || coalesce(nullif(p.name, ''), 'атлет'));

  if d.status is distinct from 'training' then
    lines := lines || case d.status
      when 'rest'   then 'Выходной'
      when 'bought' then 'Купленный выходной'
      when 'sick'   then 'Больничный'
      when 'busy'   then 'Занят, без задания'
      else 'План на день не был задан' end;
  else
    select count(*) into done from set_logs
    where athlete_id = p_athlete and date = p_date and claimed is not null;
    if done = 0 then
      lines := lines || 'Пропуск: ни одного подхода'::text;
    else
      for ex in select value from jsonb_array_elements(coalesce(d.plan, '[]'::jsonb)) loop
        select string_agg(coalesce(l.claimed::text, '—'), ' · ' order by g),
               count(*) filter (where l.has_video)
          into reps, vids
        from generate_series(1, (ex ->> 'sets')::int) g
        left join set_logs l on l.athlete_id = p_athlete and l.date = p_date
                            and l.exercise_id = (ex ->> 'id')::bigint and l.set_no = g;
        lines := lines || ((ex ->> 'name') || ': ' || reps || ' (видео ' || vids || '/' || (ex ->> 'sets') || ')');
      end loop;
    end if;
  end if;

  if m.muscles is not null or m.energy is not null then
    lines := lines || ('Утро: ' || coalesce(case m.muscles
        when 'ok' then 'мышцы в норме' when 'sore' then 'крепатура' when 'pain' then 'боль' end, '—')
      || ', энергия ' || coalesce(m.energy::text, '—'));
  end if;

  return array_to_string(lines, E'\n');
end $$;

-- ───────────── Очередь сообщений ─────────────

-- Что бот должен отправить прямо сейчас. Вызывает функция бота раз в час;
-- после успешной отправки она отмечает сообщение через bot_mark_sent.
create function public.bot_outbox()
returns table (key text, chat_id bigint, topic int, msg text)
language plpgsql security definer set search_path = public as $$
declare
  cfg     bot_settings;
  st      settings;
  now_l   timestamp := app_now();
  today   date := app_today();
  yday    date := app_today() - 1;
  a       profiles;
  d       days;
  planned int;
  done    int;
  pending int;
  body    text;
begin
  select * into cfg from bot_settings where id = 1;
  if not found or not cfg.enabled then return; end if;
  select * into st from settings where id = 1;

  if not exists (select 1 from bot_log l where l.key = 'hello') then
    key := 'hello'; chat_id := cfg.chat_id; topic := cfg.results_topic;
    msg := 'Бот на связи. Итог дня пишу сюда после 00:00, напоминание — в '
            || cfg.remind_hour || ':00, если день не заполнен.';
    return next;
  end if;

  for a in select * from profiles where role = 'athlete' and notify order by created_at loop
    -- Итог вчерашнего дня: один раз, после полуночи.
    if st.start_date is not null and yday >= st.start_date
       and not exists (select 1 from bot_log l where l.key = 'summary:' || a.id || ':' || yday) then
      perform ensure_day(a.id, yday);
      body := bot_summary_text(a.id, yday);
      select count(*) into pending from set_logs s
      where s.athlete_id = a.id and s.review = 'pending' and s.claimed is not null;
      if pending > 0 then
        body := body || E'\n' || 'Ждут проверки Тимура: ' || pending;
      end if;
      key := 'summary:' || a.id || ':' || yday; chat_id := cfg.chat_id; topic := cfg.results_topic; msg := body;
      return next;
    end if;

    -- Вечернее напоминание: в час напоминания, если тренировка заполнена не вся.
    if extract(hour from now_l) >= cfg.remind_hour
       and (st.start_date is null or today >= st.start_date)
       and not exists (select 1 from bot_log l where l.key = 'remind:' || a.id || ':' || today) then
      d := ensure_day(a.id, today);
      if d.status = 'training' then
        select coalesce(sum((value ->> 'sets')::int), 0) into planned from jsonb_array_elements(coalesce(d.plan, '[]'::jsonb));
        select count(*) into done from set_logs s
        where s.athlete_id = a.id and s.date = today and s.claimed is not null;
        if done < planned then
          key := 'remind:' || a.id || ':' || today; chat_id := cfg.chat_id; topic := cfg.results_topic;
          msg := coalesce('@' || nullif(a.tg_username, ''), nullif(a.name, ''), 'Атлет') || ', сегодня тренировка: отмечено '
                  || done || ' из ' || planned || ' подходов. День закроется в 00:00.';
          return next;
        end if;
      end if;
    end if;
  end loop;
end $$;

create function public.bot_mark_sent(p_key text) returns void
language sql security definer set search_path = public as $$
  insert into bot_log (key) values (p_key) on conflict (key) do nothing
$$;

revoke execute on function public.bot_day_title(date), public.bot_summary_text(uuid, date),
  public.bot_outbox(), public.bot_mark_sent(text) from public, anon, authenticated;
grant execute on function public.bot_outbox(), public.bot_mark_sent(text) to service_role;

-- ───────────── Расписание ─────────────
-- Каждый час в :05 будим функцию бота. Что отправлять, она решает сама по времени Таллина,
-- поэтому переход на зимнее время ничего не ломает. Лишний вызов ничего не дублирует.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'trenirovki-bot',
  '5 * * * *',
  $$ select net.http_post(
       url     := 'https://cszhygtqydszxhcrqnvu.supabase.co/functions/v1/bot',
       headers := '{"Content-Type": "application/json"}'::jsonb,
       body    := '{}'::jsonb
     ) $$
);
