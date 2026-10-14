-- Трекер тренировок · 0008: исправления после полной проверки.
-- 1. Множитель серии одинаковый для всех подходов дня: серия до этого дня + сам день.
--    Раньше подход, проверенный до конца тренировки, получал множитель на день меньше.
-- 2. Множитель хранится у подхода и виден рядом с очками.
-- 3. Подход засчитан, только если в нём больше 0 повторов (по числу Тимура, если он проверил).
--    Нули и отклонённые подходы больше не продлевают серию и не спасают от штрафа.
--    Если Тимур потом принял отклонённое и день засчитан, штраф за него возвращается.
-- 4. Смена шаблона недели не переписывает прошедшие дни (раньше давала штраф задним числом).
-- 5. Тестовый период: правка подхода убирает его теорию; выключение в тот же день
--    превращает теорию сегодняшних проверенных подходов в настоящие очки.
-- 6. Удаление записи очков подхода не даёт начислить его повторно.
-- 7. Напоминание бота считает подходы так же, как день.
-- Применять один раз целиком в Supabase → SQL Editor и сразу смёржить PR.

-- ───────────── Множитель у подхода ─────────────

alter table public.set_logs add column mult numeric;
alter table public.theory_points add column mult numeric;

-- Уже начисленным подходам — множитель из последней записи очков.
update public.set_logs s set mult = coalesce((
  select substring(l.note from 'серия ×([0-9.]+)')::numeric from public.ledger l
  where l.set_id = s.id order by l.id desc limit 1), 1)
where s.points is not null;

-- ───────────── Подход засчитан ─────────────

-- {засчитано подходов из плана, всего подходов в плане}. Засчитан — больше 0 повторов:
-- до проверки по числу друга, после — по числу Тимура (у отклонённого это 0).
create or replace function public.day_counts(p_athlete uuid, p_date date) returns int[]
language sql stable security definer set search_path = public as $$
  with p as (
    select coalesce((select plan from days where athlete_id = p_athlete and date = p_date), current_plan()) as plan
  ), e as (
    select (x ->> 'id')::bigint as id, (x ->> 'sets')::int as sets from p, jsonb_array_elements(p.plan) x
  )
  select array[
    (select count(*)::int from set_logs s join e on e.id = s.exercise_id and s.set_no <= e.sets
     where s.athlete_id = p_athlete and s.date = p_date and coalesce(s.confirmed, s.claimed) > 0),
    (select coalesce(sum(sets), 0)::int from e)]
$$;

-- Как в v3.2, плюс: если Тимур передумал (отклонённый подход принял) и день снова засчитан,
-- штраф за этот день возвращается.
create or replace function public.settle(p_athlete uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  today date := app_today();
  start date := (select start_date from settings where id = 1);
  d     date;
  r     rules;
  c     int[];
  bal   int;
  pen   int;
  price int;
  pct   int;
  x     ledger;
begin
  if start is null then return; end if;
  perform lock_athlete(p_athlete);

  d := greatest(start, today - 30);
  while d < today loop
    r := rules_for(d);
    if not coalesce(r.calibration, true) and coalesce(r.miss_penalty_pct, 0) > 0
       and day_status_of(p_athlete, d) = 'training'
       and not exists (select 1 from ledger where athlete_id = p_athlete and key = 'penalty:' || d) then
      c := day_counts(p_athlete, d);
      if c[1] < c[2] then
        perform ensure_day(p_athlete, d);
        bal := balance_of(p_athlete);
        pen := least(bal, round(bal * r.miss_penalty_pct / 100));
        insert into ledger (athlete_id, date, kind, amount, rating, note, key)
        values (p_athlete, d, 'penalty', -pen, 0,
                'Пропуск: сделано ' || c[1] || ' из ' || c[2] || ' подходов · −'
                || trim_scale(r.miss_penalty_pct)::text || '% баланса',
                'penalty:' || d);
      end if;
    end if;
    d := d + 1;
  end loop;

  for x in select * from ledger l where l.athlete_id = p_athlete and l.kind = 'penalty' and l.amount < 0
             and l.date >= today - 60
             and not exists (select 1 from ledger u where u.athlete_id = p_athlete and u.key = 'unpenalty:' || l.date) loop
    if day_done(p_athlete, x.date) then
      insert into ledger (athlete_id, date, kind, amount, note, key)
      values (p_athlete, x.date, 'refund', -x.amount, 'Штраф снят: день засчитан после проверки', 'unpenalty:' || x.date);
    end if;
  end loop;

  price := (rules_for(today)).phone_price;
  if coalesce(price, 0) > 0 then
    bal := balance_of(p_athlete);
    foreach pct in array array[25, 50, 75, 100] loop
      if bal * 100 >= price * pct
         and not exists (select 1 from ledger where athlete_id = p_athlete and key = 'milestone:' || pct) then
        insert into ledger (athlete_id, date, kind, note, key)
        values (p_athlete, today, 'milestone',
                case when pct = 100 then 'Цель: на телефон хватает' else 'Веха: ' || pct || '% пути к телефону' end,
                'milestone:' || pct);
      end if;
    end loop;
  end if;
end $$;

-- ───────────── Множитель дня ─────────────

-- Серия этого дня, если он будет сделан: полные дни подряд до него + он сам.
-- Не зависит от того, когда Тимур проверяет подходы.
create function public.day_streak(p_athlete uuid, p_date date) returns int
language sql stable security definer set search_path = public as $$
  select streak_at(p_athlete, p_date - 1) + 1
$$;

-- Как в v3.2, но множитель — по серии дня (day_streak), и он сохраняется у подхода.
create or replace function public.award_set(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  l      set_logs;
  r      rules;
  pe     jsonb;
  ex     jsonb;
  target int;
  nm     text;
  base   numeric := 0;
  k      numeric := 1;  -- множитель серии
  bon    int := 0;
  other  int;
  total  int := 0;
  cal    boolean;
  ok     boolean;
  delta  int;
  bal    int;
  note   text;
begin
  select * into l from set_logs where id = p_id;
  if not found then return; end if;
  perform lock_athlete(l.athlete_id);
  select * into l from set_logs where id = p_id for update;
  r := rules_for(l.date);
  cal := coalesce(r.calibration, true);
  if cal then r := rules_for(app_today()); end if;
  ok := l.review in ('accepted', 'corrected') and l.confirmed is not null;
  pe := coalesce(r.per_exercise -> l.exercise_id::text, '{}'::jsonb);

  select value into ex from days d, jsonb_array_elements(coalesce(d.plan, '[]'::jsonb))
  where d.athlete_id = l.athlete_id and d.date = l.date and (value ->> 'id')::bigint = l.exercise_id;
  target := (ex ->> 'target_reps')::int;
  nm := coalesce(ex ->> 'name', (select name from exercises where id = l.exercise_id), 'Подход');

  if ok then
    base := l.confirmed * coalesce((pe ->> 'rep')::numeric, 0)
          + case when l.confirmed > 0 and (target is null or l.confirmed >= target)
                 then coalesce((pe ->> 'set')::numeric, 0) else 0 end;
    if target is not null and l.confirmed > target and coalesce((pe ->> 'over')::numeric, 0) > 0 then
      bon := round((l.confirmed - target) * (pe ->> 'over')::numeric);
      if (pe ->> 'cap') is not null then
        if cal then
          select coalesce(sum(t.bonus), 0) into other from theory_points t join set_logs s on s.id = t.set_id
          where t.athlete_id = l.athlete_id and t.date = l.date and s.exercise_id = l.exercise_id and t.set_id <> l.id;
        else
          select coalesce(sum(bonus), 0) into other from set_logs
          where athlete_id = l.athlete_id and date = l.date and exercise_id = l.exercise_id and id <> l.id;
        end if;
        bon := greatest(0, least(bon, (pe ->> 'cap')::int - other));
      end if;
    end if;
    k := trim_scale(round(streak_mult(r, day_streak(l.athlete_id, l.date)), 2));
    total := round((base + bon) * k);
  end if;

  if ok and cal then
    insert into theory_points (set_id, athlete_id, date, points, bonus, mult)
    values (l.id, l.athlete_id, l.date, total, bon, k)
    on conflict (set_id) do update set points = excluded.points, bonus = excluded.bonus, mult = excluded.mult;
  else
    delete from theory_points where set_id = l.id;
  end if;

  ok := ok and not cal;
  update set_logs set points = case when ok then total end, bonus = case when ok then bon end,
    mult = case when ok then k end
  where id = l.id;

  delta := case when ok then total else 0 end - coalesce(l.points, 0);
  if delta = 0 then return; end if;

  note := nm || ' · подход ' || l.set_no;
  if l.points is not null then note := 'Пересмотр: ' || note; end if;
  if ok and k > 1 then note := note || ' · серия ×' || k::text; end if;
  if ok and bon > 0 then note := note || ' · сверх цели +' || bon; end if;

  bal := balance_of(l.athlete_id);
  insert into ledger (athlete_id, date, kind, amount, rating, note, set_id)
  values (l.athlete_id, l.date, 'set', greatest(delta, -bal), delta, note, l.id);
end $$;

-- Счёт атлета: mult — множитель на подходы сегодняшнего дня (или ближайшей тренировки).
create or replace function public.wallet(p_athlete uuid default null) returns json
language plpgsql security definer set search_path = public as $$
declare
  who uuid := coalesce(p_athlete, auth.uid());
  r   public.rules := rules_for(app_today());
  s   int;
begin
  if auth.uid() is null then raise exception 'Нужно войти'; end if;
  if who <> auth.uid() and not is_admin() then raise exception 'Нет доступа'; end if;
  perform settle(who);
  s := streak_at(who, app_today());
  return json_build_object(
    'balance', balance_of(who), 'rating', rating_of(who), 'streak', s,
    'mult', trim_scale(round(streak_mult(r, day_streak(who, app_today())), 2)), 'phone_price', r.phone_price,
    'phone_bought', (select date from ledger where athlete_id = who and key = 'phone'),
    'theory', case when is_admin() then (select coalesce(sum(points), 0) from theory_points where athlete_id = who) end);
end $$;

-- ───────────── Шаблон недели не трогает прошлое ─────────────

-- Перед сменой дня недели в шаблоне прошедшие дни с ним фиксируются со старым статусом,
-- иначе смена задним числом рвала серию и давала штрафы.
create function public.freeze_week_template() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  start date := (select start_date from settings where id = 1);
begin
  if old.status is not distinct from new.status or start is null then return new; end if;
  insert into days (athlete_id, date, status, plan)
  select p.id, g::date, old.status, case when old.status = 'training' then current_plan() end
  from profiles p, generate_series(greatest(start, app_today() - 400), app_today() - 1, interval '1 day') g
  where p.role = 'athlete' and extract(isodow from g) = old.dow
  on conflict (athlete_id, date) do nothing;
  return new;
end $$;

create trigger freeze_past_days before update on public.week_template
for each row execute function public.freeze_week_template();

-- ───────────── Тестовый период ─────────────

-- Как в v3.2, плюс: подходы с теорией пересчитываются всегда. Если тестовый период
-- выключен сегодня, теория сегодняшних проверенных подходов становится настоящими очками.
create or replace function public.save_rules(p jsonb) returns public.rules
language plpgsql security definer set search_path = public as $$
declare
  r public.rules;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  r := jsonb_populate_record(null::public.rules, p);
  r.valid_from := app_today();
  r.calibration := coalesce(r.calibration, true);
  r.per_exercise := coalesce(r.per_exercise, '{}'::jsonb);
  r.saved_at := now();
  delete from rules where valid_from > app_today();
  insert into rules values (r.*)
  on conflict (valid_from) do update set
    calibration = excluded.calibration, per_exercise = excluded.per_exercise,
    streak_from = excluded.streak_from, streak_step = excluded.streak_step, streak_max = excluded.streak_max,
    miss_penalty_pct = excluded.miss_penalty_pct,
    rest_day_price = excluded.rest_day_price, purchase_limit_week = excluded.purchase_limit_week,
    phone_price = excluded.phone_price, saved_at = excluded.saved_at
  returning * into r;
  perform award_set(s.id) from set_logs s
  where s.date > app_today() - 60 and s.review in ('accepted', 'corrected')
    and (coalesce((rules_for(s.date)).calibration, true)
         or exists (select 1 from theory_points t where t.set_id = s.id));
  return r;
end $$;

-- Как в v3, плюс: если число поменяли после проверки в тестовый период, теория подхода убирается.
create or replace function public.log_set(
  p_date date, p_exercise_id bigint, p_set_no int, p_claimed int, p_has_video boolean
) returns public.set_logs
language plpgsql security definer set search_path = public as $$
declare
  uid   uuid := auth.uid();
  today date := app_today();
  st    public.settings;
  d     public.days;
  ex    jsonb;
  prev  public.set_logs;
  res   public.set_logs;
  grace boolean;
begin
  if uid is null then raise exception 'Нужно войти'; end if;
  select * into st from settings where id = 1;

  if p_date = today then
    grace := false;
  elsif p_date = today - 1 and extract(hour from app_now()) < st.grace_hours then
    grace := true;
  else
    raise exception 'День закрыт';
  end if;

  if st.start_date is not null and p_date < st.start_date then
    raise exception 'Калибровка ещё не началась';
  end if;

  d := ensure_day(uid, p_date);
  if d.status is distinct from 'training' then
    raise exception 'В этот день нет тренировки';
  end if;

  select value into ex from jsonb_array_elements(d.plan) where (value ->> 'id')::bigint = p_exercise_id;
  if ex is null then raise exception 'Этого упражнения нет в плане дня'; end if;
  if p_set_no < 1 or p_set_no > (ex ->> 'sets')::int then raise exception 'Лишний подход'; end if;

  select * into prev from set_logs
  where athlete_id = uid and date = p_date and exercise_id = p_exercise_id and set_no = p_set_no
  for update;

  if grace then
    if not found then raise exception 'День закрыт, можно только отметить видео'; end if;
    update set_logs set has_video = p_has_video, updated_at = now()
    where id = prev.id returning * into res;
    return res;
  end if;

  if not found then
    insert into set_logs (athlete_id, date, exercise_id, set_no, claimed, has_video)
    values (uid, p_date, p_exercise_id, p_set_no, p_claimed, p_has_video)
    returning * into res;
  else
    update set_logs set
      claimed     = p_claimed,
      has_video   = p_has_video,
      -- Атлет поменял число после проверки — подход снова ждёт решения.
      review      = case when prev.claimed is distinct from p_claimed then 'pending' else prev.review end,
      confirmed   = case when prev.claimed is distinct from p_claimed then null else prev.confirmed end,
      reviewed_at = case when prev.claimed is distinct from p_claimed then null else prev.reviewed_at end,
      updated_at  = now()
    where id = prev.id returning * into res;
    if prev.claimed is distinct from p_claimed
       and (prev.points is not null or prev.bonus is not null
            or exists (select 1 from theory_points t where t.set_id = res.id)) then
      perform award_set(res.id);
      select * into res from set_logs where id = res.id;
    end if;
  end if;
  return res;
end $$;

-- ───────────── Удаление записи очков ─────────────

-- Как в v3.3, но у подхода остаются очки других его записей (начисление и пересмотры),
-- иначе повторная проверка начисляла подход второй раз.
create or replace function public.delete_ledger(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  x public.ledger;
  left_pts int;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  select * into x from ledger where id = p_id;
  if not found then raise exception 'Запись не найдена'; end if;
  perform lock_athlete(x.athlete_id);
  if x.key is not null and x.key <> 'phone' then
    update ledger set amount = 0, rating = 0,
      note = case when note like 'Удалено Тимуром: %' then note else 'Удалено Тимуром: ' || coalesce(note, '') end
    where id = p_id;
  else
    delete from ledger where id = p_id;
    if x.set_id is not null then
      select sum(rating)::int into left_pts from ledger where set_id = x.set_id;
      update set_logs set points = left_pts,
        bonus = case when left_pts is null then null else bonus end,
        mult  = case when left_pts is null then null else mult end
      where id = x.set_id;
    end if;
  end if;
end $$;

-- ───────────── Бот ─────────────
-- Как в v3.3, но напоминание считает подходы как день (day_counts): нули не в счёт.

create or replace function public.bot_outbox()
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
  who     text;
  c       int[];
  pending int;
  body    text;
  pen     ledger;
  e       record;
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
    perform settle(a.id);
    who := coalesce(nullif(a.name, ''), 'Атлет');

    -- Итог вчерашнего дня: один раз, после полуночи.
    if st.start_date is not null and yday >= st.start_date
       and not exists (select 1 from bot_log l where l.key = 'summary:' || a.id || ':' || yday) then
      perform ensure_day(a.id, yday);
      body := bot_summary_text(a.id, yday);
      select * into pen from ledger l where l.athlete_id = a.id and l.key = 'penalty:' || yday;
      if found then
        body := body || E'\n' || case when pen.amount < 0 then 'Штраф за пропуск: −' || -pen.amount
                                      else 'Штраф за пропуск: баланс уже 0' end;
      end if;
      select count(*) into pending from set_logs s
      where s.athlete_id = a.id and s.review = 'pending' and s.claimed is not null;
      if pending > 0 then
        body := body || E'\n' || 'Ждут проверки Тимура: ' || pending;
      end if;
      key := 'summary:' || a.id || ':' || yday; chat_id := cfg.chat_id; topic := cfg.results_topic; msg := body;
      return next;
    end if;

    -- Вечернее напоминание: в час напоминания, если тренировка сделана не вся.
    if extract(hour from now_l) >= cfg.remind_hour
       and (st.start_date is null or today >= st.start_date)
       and not exists (select 1 from bot_log l where l.key = 'remind:' || a.id || ':' || today) then
      d := ensure_day(a.id, today);
      if d.status = 'training' then
        c := day_counts(a.id, today);
        if c[1] < c[2] then
          key := 'remind:' || a.id || ':' || today; chat_id := cfg.chat_id; topic := cfg.results_topic;
          msg := coalesce('@' || nullif(a.tg_username, ''), nullif(a.name, ''), 'Атлет') || ', сегодня тренировка: отмечено '
                  || c[1] || ' из ' || c[2] || ' подходов. День закроется в 00:00.';
          return next;
        end if;
      end if;
    end if;

    -- События за последние двое суток, о которых бот ещё не писал.
    for e in
      select 'milestone:' || l.id as k,
             case when l.key = 'milestone:100' then who || ': очков хватает на телефон! Цель достигнута.'
                  else who || ': пройдено ' || split_part(l.key, ':', 2) || '% пути к телефону!' end as m
        from ledger l where l.athlete_id = a.id and l.kind = 'milestone' and l.created_at > now() - interval '2 days'
         and coalesce(l.note, '') not like 'Удалено Тимуром:%'
      union all
      select 'buy:' || p.id, who || ': куплен выходной на ' || bot_day_title(p.date) || ', списано ' || p.price || '.'
        from purchases p where p.athlete_id = a.id and p.status = 'active' and p.created_at > now() - interval '2 days'
      union all
      select 'cancel:' || p.id, who || ': выходной на ' || bot_day_title(p.date) || ' отменён, очки вернулись.'
        from purchases p where p.athlete_id = a.id and p.status = 'cancelled' and p.cancelled_at > now() - interval '2 days'
         and exists (select 1 from bot_log l where l.key = 'buy:' || p.id)
      union all
      select 'sick:' || s.id || ':' || extract(epoch from s.created_at)::bigint,
             who || ' просит больничный на ' || bot_day_title(s.date)
             || coalesce(': «' || s.note || '»', '') || '. Решение — во вкладке «Проверка».'
        from sick_requests s where s.athlete_id = a.id and s.status = 'pending' and s.created_at > now() - interval '2 days'
      union all
      select 'phone:' || l.id, who || ' купил телефон за ' || -l.amount || ' очков! Цель выполнена 🎉'
        from ledger l where l.athlete_id = a.id and l.key = 'phone' and l.amount < 0 and l.created_at > now() - interval '2 days'
      union all
      select 'idea:' || i.id, who || ' предлагает для магазина: «' || i.text || '»'
        from ideas i where i.athlete_id = a.id and i.created_at > now() - interval '2 days'
    loop
      continue when exists (select 1 from bot_log l where l.key = e.k);
      key := e.k; chat_id := cfg.chat_id; topic := cfg.results_topic; msg := e.m;
      return next;
    end loop;
  end loop;
end $$;

-- ───────────── Права ─────────────

revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from anon, authenticated, public;
grant execute on function
  public.app_now(), public.app_today(), public.app_clock(), public.is_admin(), public.open_day(date, uuid),
  public.log_set(date, bigint, int, int, boolean),
  public.save_morning(public.muscle_state, int, text),
  public.review_set(bigint, public.review_status, int, text),
  public.set_day_status(uuid, date, public.day_status),
  public.rules_now(), public.save_rules(jsonb), public.wallet(uuid),
  public.buy_rest_day(date), public.cancel_purchase(bigint),
  public.request_sick(text), public.decide_sick(bigint, boolean),
  public.add_idea(text), public.set_idea_status(bigint, public.idea_status),
  public.set_day_plan(uuid, date, jsonb, text), public.grant_points(uuid, int, text, boolean),
  public.delete_idea(bigint), public.reset_athlete(uuid),
  public.clear_athlete(uuid, text[], date, date), public.delete_ledger(bigint),
  public.buy_phone()
to authenticated;
grant execute on function public.bot_outbox(), public.bot_mark_sent(text) to service_role;
