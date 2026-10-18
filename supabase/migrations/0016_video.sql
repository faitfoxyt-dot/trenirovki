-- Трекер тренировок · 0016: подтверждение подходов по видео из Telegram.
-- Подходы дня пронумерованы подряд по плану дня: #1, #2 … (у каждого упражнения столько номеров,
-- сколько подходов). Номер привязан к месту в плане, поэтому замена и «Выбор» его не сдвигают.
-- Друг шлёт видео в группу с подписью «#5». Бот (Edge Function `bot`, раз в минуту) отдаёт его
-- в bot_video: если повторы у подхода #5 уже вписаны — подход принят сразу (auto = true), иначе видео
-- ждёт, и подход примется, как только друг впишет повторы. Тимур видит такие подходы в «Проверке»
-- и может отменить (undo_video) — подход вернётся на проверку, очки снимутся.
-- Включается переключателем settings.video_auto в «Плане».
-- Повторный запуск безопасен. Функции сами проверяют, кто их зовёт (права в базе не отзываются).

alter table public.settings add column if not exists video_auto boolean not null default false;
alter table public.set_logs add column if not exists video_url text;   -- ссылка на видео в Telegram
alter table public.set_logs add column if not exists auto boolean not null default false; -- принят ботом по видео
alter table public.profiles add column if not exists tg_id bigint;     -- id в Telegram, запоминается по первому видео
alter table public.bot_settings add column if not exists tg_offset bigint not null default 0; -- getUpdates
alter table public.bot_settings add column if not exists seen_at timestamptz;   -- когда бот последний раз видел сообщение из группы
alter table public.bot_settings add column if not exists admin boolean;         -- бот — админ группы (по getChatMember)
alter table public.bot_settings add column if not exists admin_at timestamptz;

-- Видео из группы. status: matched — засчитало подход, waiting — ждёт повторы, bad — подпись не подошла.
create table if not exists public.tg_videos (
  chat_id    bigint not null,
  message_id bigint not null,
  athlete_id uuid not null,
  date       date not null,
  no         int,
  caption    text,
  url        text not null,
  status     text not null check (status in ('matched', 'waiting', 'bad')),
  set_id     bigint,                             -- какой подход засчитало
  react      text,                               -- какую реакцию поставить боту (если ещё не поставил)
  reacted    boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (chat_id, message_id)
);
create index if not exists tg_videos_waiting on public.tg_videos (athlete_id, date) where status = 'waiting';

alter table public.tg_videos enable row level security;
do $$ begin
  create policy "свои или админ" on public.tg_videos
    for select to authenticated using (athlete_id = auth.uid() or public.is_admin());
exception when duplicate_object then null; end $$;

-- Зовёт только функция бота (service role) или сам Postgres (SQL Editor, расписание).
create or replace function public.is_service() returns boolean
language sql stable as $$
  select coalesce(auth.role(), 'postgres') in ('service_role', 'postgres')
$$;

-- ───────────── Номер подхода ─────────────

-- Подходы плана подряд: [{id, sets, ofs}] — ofs = сколько подходов до этого упражнения.
create or replace function public.video_slots(p_plan jsonb)
returns table (exercise_id bigint, sets int, ofs int)
language sql immutable as $$
  select (x ->> 'id')::bigint, (x ->> 'sets')::int,
         coalesce(sum((x ->> 'sets')::int) over (order by o rows between unbounded preceding and 1 preceding), 0)::int
  from jsonb_array_elements(coalesce(p_plan, '[]'::jsonb)) with ordinality t(x, o)
$$;

-- Номер подхода за день (#1…). null — такого подхода в плане нет.
create or replace function public.video_no(p_plan jsonb, p_exercise bigint, p_set int) returns int
language sql immutable as $$
  select ofs + p_set from video_slots(p_plan) where exercise_id = p_exercise and p_set between 1 and sets limit 1
$$;

-- ───────────── Приём подхода по видео ─────────────

-- Видео есть: подход отмечен «с видео». Если повторы вписаны и подход ещё не проверен — принят ботом.
create or replace function public.video_accept(p_set bigint, p_url text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  l set_logs;
begin
  select * into l from set_logs where id = p_set;
  if not found then return false; end if;
  perform lock_athlete(l.athlete_id);
  select * into l from set_logs where id = p_set for update;
  if l.claimed is null then return false; end if;
  if l.review <> 'pending' then
    -- Генерал уже решил сам — только прикрепляем видео.
    update set_logs set has_video = true, video_url = coalesce(video_url, p_url), updated_at = now() where id = p_set;
    return true;
  end if;
  update set_logs set has_video = true, video_url = p_url, auto = true, review = 'accepted',
    confirmed = claimed, reviewed_at = now(), updated_at = now()
  where id = p_set;
  perform award_set(p_set);
  perform settle(l.athlete_id);
  return true;
end $$;

-- Друг поменял повторы после подтверждения по видео — подход снова ждёт генерала, уже не «по видео».
create or replace function public.video_claim_changed() returns trigger
language plpgsql as $$
begin
  if old.auto and new.claimed is distinct from old.claimed then new.auto := false; end if;
  return new;
end $$;

-- Друг вписал повторы, а видео с этим номером уже пришло — подход принимается сразу.
create or replace function public.video_on_claim() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v   tg_videos;
  vno int;
begin
  if new.claimed is null or new.review <> 'pending' then return null; end if;
  if tg_op = 'UPDATE' and old.claimed is not null then return null; end if;
  if not (select video_auto from settings where id = 1) then return null; end if;
  select video_no(d.plan, new.exercise_id, new.set_no) into vno
  from days d where d.athlete_id = new.athlete_id and d.date = new.date;
  select * into v from tg_videos
  where athlete_id = new.athlete_id and date = new.date and no = vno and status = 'waiting'
  order by created_at desc limit 1;  -- прислал несколько с одним номером — берём последнее
  if not found then return null; end if;
  perform video_accept(new.id, v.url);
  update tg_videos set status = case when message_id = v.message_id then 'matched' else 'bad' end,
    set_id = case when message_id = v.message_id then new.id end,
    react = case when message_id = v.message_id then '🫡' else '' end, reacted = false, updated_at = now()
  where athlete_id = new.athlete_id and date = new.date and no = vno and status = 'waiting';
  return null;
end $$;

do $$ begin
  create trigger set_logs_video_claim before update of claimed on public.set_logs
    for each row execute function public.video_claim_changed();
exception when duplicate_object then null; end $$;
do $$ begin
  create trigger set_logs_video_on_claim after insert or update of claimed on public.set_logs
    for each row execute function public.video_on_claim();
exception when duplicate_object then null; end $$;

-- ───────────── Бот ─────────────

-- Что нужно функции бота перед опросом Telegram.
create or replace function public.bot_poll_state() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_service() then raise exception 'Только для бота'; end if;
  return (select json_build_object(
    'chat_id', b.chat_id, 'offset', b.tg_offset, 'on', s.video_auto and b.enabled,
    'check_admin', b.admin_at is null or b.admin_at < now() - interval '15 minutes')
    from bot_settings b, settings s where b.id = 1 and s.id = 1);
end $$;

-- После опроса: следующий offset и видел ли бот сообщения из группы.
create or replace function public.bot_polled(p_offset bigint, p_seen boolean, p_admin boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_service() then raise exception 'Только для бота'; end if;
  update bot_settings set
    tg_offset = greatest(tg_offset, coalesce(p_offset, 0)),
    seen_at   = case when p_seen then now() else seen_at end,
    admin     = coalesce(p_admin, admin),
    admin_at  = case when p_admin is not null then now() else admin_at end
  where id = 1;
end $$;

-- Одно видео из группы. p: {chat_id, message_id, user_id, username, caption, date (unix)}.
-- Ответ: {react: '🫡' | '👀' | '', reply?: текст} или {} — ничего не делать.
create or replace function public.bot_video(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cfg   bot_settings;
  st    settings;
  a     profiles;
  prev  tg_videos;
  d     days;
  l     set_logs;
  ts    timestamp;
  dt    date;
  cap   text := coalesce(p ->> 'caption', '');
  num   int;
  total int;
  slot  record;
  url   text;
  when_ text;
  res   jsonb;
  stat  text;
  sid   bigint;
begin
  if not is_service() then raise exception 'Только для бота'; end if;
  select * into cfg from bot_settings where id = 1;
  select * into st from settings where id = 1;
  if (p ->> 'chat_id')::bigint is distinct from cfg.chat_id or not st.video_auto then return '{}'; end if;

  -- Только видео атлетов (по id в Telegram, а в первый раз — по нику).
  select * into a from profiles
  where role = 'athlete' and (tg_id = (p ->> 'user_id')::bigint
     or (tg_id is null and lower(tg_username) = lower(nullif(p ->> 'username', ''))))
  order by tg_id nulls last limit 1;
  if not found then return '{}'; end if;
  if a.tg_id is null then update profiles set tg_id = (p ->> 'user_id')::bigint where id = a.id; end if;

  select * into prev from tg_videos where chat_id = cfg.chat_id and message_id = (p ->> 'message_id')::bigint;
  -- Уже засчитано или подпись не менялась — второй раз не отвечаем.
  if found and (prev.status = 'matched' or prev.caption is not distinct from cap) then return '{}'; end if;

  -- День — по времени отправки; до grace_hours (03:00) видео идёт во вчерашний день.
  ts := to_timestamp((p ->> 'date')::double precision) at time zone 'Europe/Tallinn';
  dt := ts::date - case when extract(hour from ts) < st.grace_hours then 1 else 0 end;
  when_ := case when dt = app_today() then 'сегодня' when dt = app_today() - 1 then 'вчера' else to_char(dt, 'DD.MM') end;
  url := 'https://t.me/c/' || substr(abs(cfg.chat_id)::text, 4) || '/' || (p ->> 'message_id');

  num := coalesce(substring(cap from '#\s*(\d{1,3})'), substring(cap from '^\s*(\d{1,3})(?:\D|$)'))::int;
  d := ensure_day(a.id, dt);  -- день мог ещё не открываться на сайте
  select coalesce(sum(sets), 0) into total from video_slots(d.plan);

  if num is null then
    stat := 'bad';
    res := jsonb_build_object('react', '', 'reply',
      'Не вижу номер подхода. Подпиши видео так: #5 — номер есть на сайте у каждого подхода. Подпись можно исправить (зажми видео → Изменить).');
  elsif d.status is distinct from 'training' or total = 0 then
    stat := 'bad';
    res := jsonb_build_object('react', '', 'reply', 'На ' || when_ || ' нет тренировки — видео не засчитано.');
  elsif num < 1 or num > total then
    stat := 'bad';
    res := jsonb_build_object('react', '', 'reply',
      'Подхода #' || num || ' ' || when_ || ' нет, всего их ' || total || '. Исправь подпись (зажми видео → Изменить), я перечитаю.');
  else
    select exercise_id, num - ofs as set_no into slot from video_slots(d.plan)
    where num > ofs and num <= ofs + sets limit 1;
    select * into l from set_logs
    where athlete_id = a.id and date = dt and exercise_id = slot.exercise_id and set_no = slot.set_no;
    if found and exists (select 1 from tg_videos t where t.set_id = l.id and t.status = 'matched'
                         and t.message_id <> (p ->> 'message_id')::bigint) then
      stat := 'bad';
      res := jsonb_build_object('react', '', 'reply',
        'Подход #' || num || ' уже засчитан другим видео. Проверь номер'
        || case when num < total then ' — может, это #' || (num + 1) || '?' else '.' end);
    elsif found and l.claimed is not null then
      perform video_accept(l.id, url);
      stat := 'matched'; sid := l.id;
      res := jsonb_build_object('react', '🫡');
    elsif dt < app_today() then
      stat := 'bad';
      res := jsonb_build_object('react', '', 'reply',
        'У вчерашнего подхода #' || num || ' нет повторов, а вписать их уже нельзя. Генерал решит сам.');
    else
      stat := 'waiting';
      res := jsonb_build_object('react', '👀');
    end if;
  end if;

  insert into tg_videos (chat_id, message_id, athlete_id, date, no, caption, url, status, set_id)
  values (cfg.chat_id, (p ->> 'message_id')::bigint, a.id, dt, num, cap, url, stat, sid)
  on conflict (chat_id, message_id) do update set date = excluded.date, no = excluded.no, caption = excluded.caption,
    status = excluded.status, set_id = excluded.set_id, react = null, reacted = true, updated_at = now();
  return res;
end $$;

-- Реакции, которые бот ещё не поставил (подход принят позже, когда друг вписал повторы). Отдаёт один раз.
create or replace function public.bot_reactions()
returns table (chat_id bigint, message_id bigint, react text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not is_service() then raise exception 'Только для бота'; end if;
  return query
  update tg_videos t set reacted = true, updated_at = now()
  where not t.reacted and t.react is not null
  returning t.chat_id, t.message_id, t.react;
end $$;

-- ───────────── Для сайта ─────────────

create or replace function public.video_settings() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('on', s.video_auto,
    'bot_sees', coalesce(b.admin, false) or exists (select 1 from tg_videos),
    'checked', b.admin_at is not null)
  from settings s, bot_settings b where s.id = 1 and b.id = 1 and auth.uid() is not null
$$;

create or replace function public.set_video_auto(p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  update settings set video_auto = coalesce(p_on, false), updated_at = now() where id = 1;
end $$;

-- Видео, к которым ещё нет повторов: [{no, url}].
create or replace function public.waiting_videos(p_athlete uuid, p_date date) returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object('no', no, 'url', url) order by no), '[]'::json)
  from tg_videos
  where athlete_id = p_athlete and date = p_date and status = 'waiting'
    and (p_athlete = auth.uid() or is_admin())
$$;

-- Подходы, принятые ботом по видео за сегодня и вчера, с номером #.
create or replace function public.video_confirmed() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  return (select coalesce(json_agg(to_jsonb(l) || jsonb_build_object('no', video_no(d.plan, l.exercise_id, l.set_no))
                                   order by l.date desc, l.id), '[]'::json)
          from set_logs l left join days d on d.athlete_id = l.athlete_id and d.date = l.date
          where l.auto and l.review = 'accepted' and l.date >= app_today() - 1);
end $$;

-- Генерал отменяет подтверждение по видео: подход снова ждёт решения, очки снимаются.
create or replace function public.undo_video(p_id bigint) returns public.set_logs
language plpgsql security definer set search_path = public as $$
declare
  l   set_logs;
  res set_logs;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  select * into l from set_logs where id = p_id;
  if not found or not l.auto then raise exception 'Этот подход не подтверждён по видео'; end if;
  update set_logs set review = 'pending', confirmed = null, auto = false, reviewed_at = null, updated_at = now()
  where id = p_id;
  perform award_set(p_id);
  perform settle(l.athlete_id);
  select * into res from set_logs where id = p_id;
  return res;
end $$;

-- ───────────── Права ─────────────

grant execute on function public.video_settings(), public.set_video_auto(boolean),
  public.waiting_videos(uuid, date), public.video_confirmed(), public.undo_video(bigint) to authenticated;
grant execute on function public.bot_poll_state(), public.bot_polled(bigint, boolean, boolean),
  public.bot_video(jsonb), public.bot_reactions() to service_role;

-- ───────────── Расписание ─────────────

-- Раз в минуту бот забирает новые видео из группы (тело {"poll": true}). Итоги и напоминания —
-- по-прежнему задание trenirovki-bot раз в час.
select cron.schedule(
  'trenirovki-bot-poll',
  '* * * * *',
  $$ select net.http_post(
       url     := 'https://cszhygtqydszxhcrqnvu.supabase.co/functions/v1/bot',
       headers := '{"Content-Type": "application/json", "apikey": "sb_publishable_YfPspbgiMuySizPLIUQ6eg_guCb3SmI"}'::jsonb,
       body    := '{"poll": true}'::jsonb
     ) $$
);
