-- 0028: «За гранью предела» — подход на пари отдельным видео.
-- Ставка больше не ищется среди подходов плана. В день пари друг шлёт видео в тему «Видео»
-- с подписью «#пари Название», бот прикрепляет его к ставке дня, генерал в «Проверке»
-- засчитывает (приз) или нет. Видео можно прислать в день ставки или в два следующих дня;
-- не засчитал — можно прислать новое.

alter table public.pari_bets
  add column if not exists video_url text,
  add column if not exists video_at timestamptz,
  add column if not exists review text,
  add column if not exists reviewed_at timestamptz;
do $$ begin
  alter table public.pari_bets add constraint pari_bets_review_check check (review in ('pending', 'accepted', 'rejected'));
exception when duplicate_object then null; end $$;

-- Итог ставки: won — генерал засчитал видео, check — видео ждёт генерала,
-- lost — не засчитал или день прошёл без видео, wait — ещё впереди.
create or replace function public.pari_state(p_athlete uuid, p_date date) returns json
language plpgsql stable security definer set search_path = public as $$
declare
  b   record;
  x   pari_bets;
  st  text;
begin
  select * into b from pari_bet_at(p_athlete, p_date);
  if not found then return null; end if;
  select * into x from pari_bets where pari_id = b.pari_id and n = b.n;
  st := case when x.review = 'accepted' then 'won'
             when x.review = 'pending' then 'check'
             when x.review = 'rejected' or p_date < app_today() then 'lost'
             else 'wait' end;
  return json_build_object('pari_id', b.pari_id, 'n', b.n, 'date', p_date, 'exercise_id', b.exercise_id,
    'name', b.name, 'unit', b.unit, 'reps', b.reps, 'base', b.base, 'pct', b.pct, 'prize', b.prize,
    'review', x.review, 'video_url', x.video_url, 'state', st, 'points', b.prize, 'test', is_test_day(p_date));
end $$;

create or replace function public.pari_apply(p_athlete uuid, p_date date) returns void
language plpgsql security definer set search_path = public as $$
declare
  s     json := pari_state(p_athlete, p_date);
  want  int := 0;
  have  int;
  delta int;
begin
  if is_test_day(p_date) then return; end if;
  if s is not null and s ->> 'state' = 'won' then want := (s ->> 'points')::int; end if;
  select coalesce(sum(rating), 0) into have from ledger
  where athlete_id = p_athlete and date = p_date and kind = 'pari';
  delta := want - have;
  if delta = 0 then return; end if;
  insert into ledger (athlete_id, date, kind, amount, rating, note)
  values (p_athlete, p_date, 'pari', greatest(delta, -balance_of(p_athlete)), delta,
          case when want = 0 then 'За гранью предела: приз снят'
               else case when have <> 0 then 'Пересмотр: ' else '' end
                    || 'За гранью предела: ' || (s ->> 'name') || ' по видео, ставка '
                    || (s ->> 'reps') || ' (+' || (s ->> 'pct') || '%)' end);
end $$;

-- Подходы плана снова принимаются по видео как обычно: ставка решается отдельным видео.
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

-- Видео «#пари» от бота: прикрепить к ставке и отдать генералу. Подходит ставка этого дня или двух
-- прошлых (не успел скинуть — можно позже); если их несколько, берём ту, чьё название есть в подписи.
-- Возвращает текст ответа в группе или null — всё ок.
create or replace function public.pari_video(p_athlete uuid, p_date date, p_url text, p_caption text) returns text
language plpgsql security definer set search_path = public as $$
declare
  b      record;
  x      pari_bets;
  k      int;
  won    boolean := false;
  p_id   bigint;
  p_n    int;
  p_name text;
begin
  perform lock_athlete(p_athlete);
  for k in 0..2 loop
    for b in select * from pari_bet_at(p_athlete, p_date - k) loop
      select * into x from pari_bets where pari_id = b.pari_id and n = b.n;
      if x.review = 'accepted' then won := true; continue; end if;
      if p_id is null or (strpos(lower(p_caption), lower(b.name)) > 0 and strpos(lower(p_caption), lower(p_name)) = 0) then
        p_id := b.pari_id; p_n := b.n; p_name := b.name;
      end if;
    end loop;
  end loop;
  if p_id is null then
    return case when won then 'Пари уже засчитано 🏆' else 'Сейчас у тебя нет пари — видео не засчитано.' end;
  end if;
  update pari_bets set video_url = p_url, video_at = now(), review = 'pending', reviewed_at = null
  where pari_id = p_id and n = p_n;
  return null;
end $$;

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
  msg   text;
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

  -- «#пари …» — подход на ставку «За гранью предела»: к ставке дня, решает генерал.
  if cap ~* '#\s*пари' then
    msg := pari_video(a.id, dt, url, cap);
    if msg is null then
      stat := 'matched';
      res := jsonb_build_object('react', '👀');
    else
      stat := 'bad';
      res := jsonb_build_object('react', '', 'reply', msg);
    end if;
    insert into tg_videos (chat_id, message_id, athlete_id, date, no, caption, url, status, set_id)
    values (cfg.chat_id, (p ->> 'message_id')::bigint, a.id, dt, null, cap, url, stat, null)
    on conflict (chat_id, message_id) do update set date = excluded.date, no = null, caption = excluded.caption,
      status = excluded.status, set_id = null, react = null, reacted = true, updated_at = now();
    return res;
  end if;

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

-- Генералу: видео на пари, которые ждут решения.
create or replace function public.pari_pending() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Только для генерала'; end if;
  return (select coalesce(json_agg(json_build_object('pari_id', p.id, 'n', b.n, 'athlete_id', p.athlete_id,
      'date', (pari_days(p.athlete_id, p.start))[b.n], 'name', b.name, 'unit', b.unit, 'reps', b.reps, 'pct', b.pct,
      'prize', b.prize, 'video_url', b.video_url, 'video_at', b.video_at) order by b.video_at), '[]'::json)
    from pari p join pari_bets b on b.pari_id = p.id
    where p.status = 'active' and b.review = 'pending');
end $$;

-- Решение генерала по видео: засчитать (приз) или нет.
create or replace function public.pari_review(p_pari bigint, p_n int, p_ok boolean) returns json
language plpgsql security definer set search_path = public as $$
declare
  p  pari;
  x  pari_bets;
  dt date;
begin
  if not is_admin() then raise exception 'Только для генерала'; end if;
  select * into p from pari where id = p_pari and status = 'active';
  if not found then raise exception 'Пари не найдено'; end if;
  perform lock_athlete(p.athlete_id);
  select * into x from pari_bets where pari_id = p_pari and n = p_n for update;
  if not found or x.video_url is null then raise exception 'Видео по этой ставке нет'; end if;
  update pari_bets set review = case when p_ok then 'accepted' else 'rejected' end, reviewed_at = now()
  where pari_id = p_pari and n = p_n;
  dt := (pari_days(p.athlete_id, p.start))[p_n];
  perform pari_apply(p.athlete_id, dt);
  return pari_state(p.athlete_id, dt);
end $$;

grant execute on function public.pari_pending(), public.pari_review(bigint, int, boolean) to authenticated;
