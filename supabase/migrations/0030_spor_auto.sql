-- 0030: «Спор с генералом» — приз сразу, генерал может оспорить.
-- Друг подписывает видео на пари как ему удобно: «#пари …» или «Спор с генералом» — бот понимает оба.
-- Как только видео пришло, приз ставки (у +50% это 5000) начисляется сразу. Генерал в «Проверке»
-- жмёт «Принять» (ничего не меняется) или «Оспорить» (приз снимается). Оспорил — друг может
-- прислать новое видео, пока не прошли 2 дня.

-- Итог ставки: won — генерал принял, check — видео пришло, приз уже начислен, генерал ещё не смотрел,
-- lost — оспорено или день прошёл без видео, wait — ещё впереди.
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

-- Приз начисляется и пока видео ждёт генерала (check), и после «Принять» (won). «Оспорить» — снимается.
create or replace function public.pari_apply(p_athlete uuid, p_date date) returns void
language plpgsql security definer set search_path = public as $$
declare
  s     json := pari_state(p_athlete, p_date);
  want  int := 0;
  have  int;
  delta int;
begin
  if is_test_day(p_date) then return; end if;
  if s is not null and s ->> 'state' in ('won', 'check') then want := (s ->> 'points')::int; end if;
  select coalesce(sum(rating), 0) into have from ledger
  where athlete_id = p_athlete and date = p_date and kind = 'pari';
  delta := want - have;
  if delta = 0 then return; end if;
  insert into ledger (athlete_id, date, kind, amount, rating, note)
  values (p_athlete, p_date, 'pari', greatest(delta, -balance_of(p_athlete)), delta,
          case when want = 0 then
                 case when s ->> 'review' = 'rejected' then 'Спор с генералом: генерал оспорил видео, приз снят'
                      else 'Спор с генералом: приз снят' end
               else case when have <> 0 then 'Пересмотр: ' else '' end
                    || 'Спор с генералом: ' || (s ->> 'name') || ' по видео, ставка '
                    || (s ->> 'reps') || ' (+' || (s ->> 'pct') || '%)' end);
end $$;

-- Видео на спор от бота: прикрепить к ставке этого дня или двух прошлых и сразу начислить приз.
-- Какую ставку берём: ту, чьё название есть в подписи, иначе ближайшую по дню (как в 0028).
-- Второе видео на ту же ставку заменяет первое, приз второй раз не идёт.
-- Возвращает {ok, reply}: reply — ответ в группе.
create or replace function public.pari_take(p_athlete uuid, p_date date, p_url text, p_caption text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b    record;
  x    pari_bets;
  k    int;
  won  boolean := false;
  cap  text := lower(coalesce(p_caption, ''));
  rank int;
  best int := 9;   -- 1 — название в подписи, 2 — остальные; при равенстве — ближайший день
  pid  bigint;
  pn   int;
  pdt  date;
  was  text;
  s    json;
begin
  perform lock_athlete(p_athlete);
  for k in 0..2 loop
    for b in select * from pari_bet_at(p_athlete, p_date - k) loop
      select * into x from pari_bets where pari_id = b.pari_id and n = b.n;
      if x.review = 'accepted' then won := true; continue; end if;
      rank := case when strpos(cap, lower(b.name)) > 0 then 1 else 2 end;
      if rank < best then best := rank; pid := b.pari_id; pn := b.n; pdt := p_date - k; end if;
    end loop;
  end loop;
  if pid is null then
    return jsonb_build_object('ok', false, 'reply',
      case when won then 'Этот спор с генералом уже засчитан 🏆'
           else 'Сейчас у тебя нет спора с генералом — видео не засчитано.' end);
  end if;
  select review into was from pari_bets where pari_id = pid and n = pn;
  update pari_bets set video_url = p_url, video_at = now(), review = 'pending', reviewed_at = null
  where pari_id = pid and n = pn;
  perform pari_apply(p_athlete, pdt);
  s := pari_state(p_athlete, pdt);
  return jsonb_build_object('ok', true, 'reply',
    case when was = 'pending' then 'Видео обновил 👍 Приз за спор уже у тебя, генерал посмотрит.'
         when (s ->> 'test')::boolean then '🔥 Спор с генералом: видео принял, генерал посмотрит. В тестовый период очков нет.'
         else '🔥 +' || (s ->> 'prize') || ' за спор с генералом! Генерал ещё посмотрит видео.' end);
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
  pr    jsonb;
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

  -- «#пари …» или «Спор с генералом» — подход на ставку: приз сразу, генерал может оспорить.
  if cap ~* '#\s*пари' or cap ~* 'спор\s+с\s+генерал' then
    pr := pari_take(a.id, dt, url, cap);
    stat := case when (pr ->> 'ok')::boolean then 'matched' else 'bad' end;
    res := jsonb_build_object('react', case when stat = 'matched' then '🔥' else '' end, 'reply', pr ->> 'reply');
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

-- Решение генерала: «Принять» (приз остаётся) или «Оспорить» (приз снимается).
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

-- Внутренние — только для бота и базы.
revoke all on function public.pari_take(uuid, date, text, text) from public, anon, authenticated;
revoke all on function public.pari_video(uuid, date, text, text) from public, anon, authenticated;
revoke all on function public.pari_apply(uuid, date) from public, anon, authenticated;
grant execute on function public.pari_review(bigint, int, boolean) to authenticated;
