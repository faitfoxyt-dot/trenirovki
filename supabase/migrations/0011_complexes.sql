-- Трекер тренировок · 0011: несколько комплексов (А, Б, В…), которые чередуются.
-- Комплексы идут по кругу по тренировочным дням: А, Б, В, А, Б…
-- Выходной, больничный, «занят» и купленный выходной очередь не двигают — комплекс переходит
-- на следующую тренировку. Пропущенная тренировка очередь двигает (как обычный тренировочный день).
-- Точка отсчёта: settings.rotation_from — день, с которого идёт комплекс номер rotation_shift.
-- Повторный запуск безопасен.

-- Комплексы хранятся в настройках одним списком: [[{id, sets, target_reps}, …], …] — А, Б, В…
alter table public.settings add column if not exists complexes jsonb not null default '[]'::jsonb;
do $$ begin
  alter table public.settings add constraint settings_complexes_check check (jsonb_typeof(complexes) = 'array');
exception when duplicate_object then null; end $$;
alter table public.settings add column if not exists rotation_from date;
alter table public.settings add column if not exists rotation_shift int not null default 0;

-- Первый комплекс — тот, что был общим.
update public.settings set complexes = jsonb_build_array(
  (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'sets', sets, 'target_reps', target_reps)
                             order by position, id), '[]'::jsonb)
   from public.exercises where active and not archived))
where id = 1 and complexes = '[]'::jsonb;

-- Какой по счёту комплекс (с нуля) у атлета в этот день. null — комплексов нет.
create or replace function public.complex_index(p_athlete uuid, p_date date) returns int
language plpgsql stable security definer set search_path = public as $$
declare
  s      settings;
  n      int;
  anchor date;
  k      int;
begin
  select * into s from settings where id = 1;
  n := jsonb_array_length(s.complexes);
  if n = 0 then return null; end if;
  anchor := coalesce(s.rotation_from, s.start_date, app_today());
  -- Тренировочные дни между точкой отсчёта и этим днём (статус — как в day_status_of).
  select count(*)::int into k
  from generate_series(least(anchor, p_date), greatest(anchor, p_date) - 1, interval '1 day') g
  left join days d on d.athlete_id = p_athlete and d.date = g::date
  left join week_template w on w.dow = extract(isodow from g)
  where case when d.date is not null then d.status else w.status end = 'training';
  if p_date < anchor then k := -k; end if;
  return ((s.rotation_shift + k) % n + n) % n;
end $$;

-- Снимок комплекса на день атлета: [{id, name, unit, sets, target_reps}].
create or replace function public.current_plan(p_athlete uuid, p_date date) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', e.id, 'name', e.name, 'unit', e.unit,
           'sets', (x ->> 'sets')::int, 'target_reps', (x ->> 'target_reps')::int) order by o), '[]'::jsonb)
  from settings s,
       jsonb_array_elements(coalesce(s.complexes -> coalesce(complex_index(p_athlete, p_date), 0), '[]'::jsonb))
         with ordinality as t(x, o)
  join exercises e on e.id = (x ->> 'id')::bigint and not e.archived
  where s.id = 1
$$;

-- Как в v1, только комплекс — по очереди на этот день.
create or replace function public.ensure_day(p_athlete uuid, p_date date) returns public.days
language plpgsql security definer set search_path = public as $$
declare
  d public.days;
begin
  select * into d from days where athlete_id = p_athlete and date = p_date;
  if not found then
    if p_date > app_today() then
      return null;
    end if;
    insert into days (athlete_id, date, status)
    values (p_athlete, p_date,
            (select status from week_template where dow = extract(isodow from p_date)))
    returning * into d;
  end if;
  if d.status = 'training' and d.plan is null and p_date <= app_today() then
    update days set plan = current_plan(p_athlete, p_date), updated_at = now()
    where athlete_id = p_athlete and date = p_date
    returning * into d;
  end if;
  return d;
end $$;

-- Как в v3, только комплекс — по очереди на этот день.
create or replace function public.set_day_status(p_athlete uuid, p_date date, p_status public.day_status)
returns public.days
language plpgsql security definer set search_path = public as $$
declare
  res public.days;
  pur public.purchases;
  pen public.ledger;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  if p_status = 'bought' then raise exception 'Купленный выходной ставит атлет в магазине'; end if;
  perform lock_athlete(p_athlete);

  insert into days (athlete_id, date, status) values (p_athlete, p_date, p_status)
  on conflict (athlete_id, date) do update set status = excluded.status, updated_at = now()
  returning * into res;
  if p_status = 'training' and res.plan is null and p_date <= app_today() then
    update days set plan = current_plan(p_athlete, p_date) where athlete_id = p_athlete and date = p_date
    returning * into res;
  end if;

  select * into pur from purchases where athlete_id = p_athlete and date = p_date and status = 'active';
  if found then
    update purchases set status = 'cancelled', cancelled_at = now() where id = pur.id;
    insert into ledger (athlete_id, date, kind, amount, note)
    values (p_athlete, p_date, 'refund', pur.price, 'Тимур поменял день: очки за выходной вернулись');
  end if;

  if p_status <> 'training' then
    select * into pen from ledger where athlete_id = p_athlete and key = 'penalty:' || p_date;
    if found and pen.amount < 0
       and not exists (select 1 from ledger where athlete_id = p_athlete and key = 'unpenalty:' || p_date) then
      insert into ledger (athlete_id, date, kind, amount, note, key)
      values (p_athlete, p_date, 'refund', -pen.amount, 'Штраф снят: день стал «' ||
              case p_status when 'sick' then 'больничный' when 'rest' then 'выходной' else 'занят' end || '»',
              'unpenalty:' || p_date);
    end if;
  end if;
  return res;
end $$;

-- Как в 0008, только комплекс — по очереди на этот день.
create or replace function public.day_counts(p_athlete uuid, p_date date) returns int[]
language sql stable security definer set search_path = public as $$
  with p as (
    select coalesce((select plan from days where athlete_id = p_athlete and date = p_date),
                    current_plan(p_athlete, p_date)) as plan
  ), e as (
    select (x ->> 'id')::bigint as id, (x ->> 'sets')::int as sets from p, jsonb_array_elements(p.plan) x
  )
  select array[
    (select count(*)::int from set_logs s join e on e.id = s.exercise_id and s.set_no <= e.sets
     where s.athlete_id = p_athlete and s.date = p_date and coalesce(s.confirmed, s.claimed) > 0),
    (select coalesce(sum(sets), 0)::int from e)]
$$;

-- Как в 0008, только комплекс — по очереди на каждый день.
create or replace function public.freeze_week_template() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  start date := (select start_date from settings where id = 1);
begin
  if old.status is not distinct from new.status or start is null then return new; end if;
  insert into days (athlete_id, date, status, plan)
  select p.id, g::date, old.status, case when old.status = 'training' then current_plan(p.id, g::date) end
  from profiles p, generate_series(greatest(start, app_today() - 400), app_today() - 1, interval '1 day') g
  where p.role = 'athlete' and extract(isodow from g) = old.dow
  on conflict (athlete_id, date) do nothing;
  return new;
end $$;

-- Как в 0010, только «вернуть общий» — комплекс по очереди на этот день.
create or replace function public.set_day_plan(p_athlete uuid, p_date date, p_plan jsonb, p_note text) returns public.days
language plpgsql security definer set search_path = public as $$
declare
  res    public.days;
  v_plan jsonb;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  if p_date < app_today() then raise exception 'Прошедший день менять нельзя'; end if;
  if p_plan is not null then
    if jsonb_typeof(p_plan) <> 'array' or jsonb_array_length(p_plan) = 0 then
      raise exception 'В плане дня нужно хотя бы одно упражнение';
    end if;
    select jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'unit', e.unit, 'sets', (x ->> 'sets')::int,
                                        'target_reps', (x ->> 'target_reps')::int) order by o)
      into v_plan
    from jsonb_array_elements(p_plan) with ordinality as t(x, o)
    join exercises e on e.id = (x ->> 'id')::bigint;
    if jsonb_array_length(coalesce(v_plan, '[]'::jsonb)) <> jsonb_array_length(p_plan) then
      raise exception 'В плане есть неизвестное упражнение';
    end if;
    if exists (select 1 from jsonb_array_elements(v_plan) x
               where (x ->> 'sets')::int not between 1 and 10
                  or ((x ->> 'target_reps') is not null and (x ->> 'target_reps')::int not between 1 and 1000)) then
      raise exception 'Подходов — от 1 до 10, цель — от 1 до 1000';
    end if;
  end if;

  perform set_day_status(p_athlete, p_date, 'training');
  update days set
    plan = case when p_plan is not null then v_plan
                when p_date = app_today() then current_plan(p_athlete, p_date) end,
    note = nullif(trim(p_note), ''),
    updated_at = now()
  where athlete_id = p_athlete and date = p_date
  returning * into res;
  return res;
end $$;

-- Сохранить все комплексы разом: p_list = [[{id, sets, target_reps}, …], …] по порядку А, Б, В…
-- p_next — какой комплекс (с нуля) сегодня, а если сегодня не тренировка — на ближайшей тренировке.
-- Сегодняшний день, где друг ещё ничего не отметил и план не меняли вручную, получает новый комплекс.
create or replace function public.save_complexes(p_list jsonb, p_next int) returns void
language plpgsql security definer set search_path = public as $$
declare
  today date := app_today();
  n     int;
  old   jsonb := '{}'::jsonb;
  a     uuid;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  if jsonb_typeof(p_list) <> 'array' or jsonb_array_length(p_list) not between 1 and 5 then
    raise exception 'Комплексов — от 1 до 5';
  end if;
  n := jsonb_array_length(p_list);
  if p_next is null or p_next not between 0 and n - 1 then raise exception 'Нет такого комплекса'; end if;
  if exists (select 1 from jsonb_array_elements(p_list) c where jsonb_typeof(c) <> 'array') then
    raise exception 'Комплекс — это список упражнений';
  end if;
  if exists (select 1 from jsonb_array_elements(p_list) c, jsonb_array_elements(c) x
             where not exists (select 1 from exercises e where e.id = (x ->> 'id')::bigint and not e.archived)) then
    raise exception 'В комплексе есть неизвестное упражнение';
  end if;
  if exists (select 1 from jsonb_array_elements(p_list) c, jsonb_array_elements(c) x
             where coalesce((x ->> 'sets')::int, 0) not between 1 and 10
                or ((x ->> 'target_reps') is not null and (x ->> 'target_reps')::int not between 1 and 1000)) then
    raise exception 'Подходов — от 1 до 10, цель — от 1 до 1000';
  end if;
  if exists (select 1 from jsonb_array_elements(p_list) with ordinality c(v, i), jsonb_array_elements(v) x
             group by i, x ->> 'id' having count(*) > 1) then
    raise exception 'Упражнение повторяется в одном комплексе';
  end if;

  for a in select id from profiles where role = 'athlete' loop
    old := old || jsonb_build_object(a::text, current_plan(a, today));
  end loop;

  update settings set
    complexes = (select jsonb_agg(coalesce((select jsonb_agg(jsonb_build_object(
                     'id', (x ->> 'id')::bigint, 'sets', (x ->> 'sets')::int, 'target_reps', (x ->> 'target_reps')::int) order by o)
                   from jsonb_array_elements(v) with ordinality t(x, o)), '[]'::jsonb) order by i)
                 from jsonb_array_elements(p_list) with ordinality c(v, i)),
    rotation_from = today, rotation_shift = p_next, updated_at = now()
  where id = 1;
  -- active = упражнение есть хоть в одном комплексе.
  update exercises set active = id in (select (x ->> 'id')::bigint
                                       from settings s, jsonb_array_elements(s.complexes) c, jsonb_array_elements(c) x)
  where true;

  update days d set plan = current_plan(d.athlete_id, today), updated_at = now()
  where d.date = today and d.status = 'training' and d.plan = old -> d.athlete_id::text
    and not exists (select 1 from set_logs s where s.athlete_id = d.athlete_id and s.date = today and s.claimed is not null);
end $$;

-- Расписание атлета по дням: [{date, status, complex}], complex — номер с нуля
-- (у нетренировочного дня — какой комплекс он получил бы, став тренировкой).
create or replace function public.complex_schedule(p_athlete uuid, p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Нужно войти'; end if;
  if p_athlete <> auth.uid() and not is_admin() then raise exception 'Только для админа'; end if;
  if p_to < p_from or p_to - p_from > 62 then raise exception 'Не больше двух месяцев'; end if;
  return (select coalesce(json_agg(json_build_object(
            'date', g::date, 'status', s,
            'complex', complex_index(p_athlete, g::date)) order by g), '[]'::json)
          from generate_series(p_from, p_to, interval '1 day') g,
               lateral (select day_status_of(p_athlete, g::date) as s) x);
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
  public.buy_phone(), public.save_complexes(jsonb, int), public.complex_schedule(uuid, date, date)
to authenticated;
grant execute on function public.bot_outbox(), public.bot_mark_sent(text) to service_role;
