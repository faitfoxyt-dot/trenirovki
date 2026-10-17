-- Трекер тренировок · 0015: пробный «Выбор упражнения».
-- Переключатель settings.choice. Когда он включён, у пункта комплекса может быть второй вариант
-- alt = {id, target_reps}: друг сам берёт один из двух на «Сегодня».
-- В плане дня такой пункт хранит оба варианта: pick = [вариант 1, вариант 2], chosen — какой выбран
-- (null — ещё не выбрал, тогда пункт считается первым вариантом). Поменять выбор можно,
-- пока у упражнения не отмечен ни один подход. Очки, серия, пропуск и ALL IN — по плану, как обычно.
-- Повторный запуск безопасен.

alter table public.settings add column if not exists choice boolean not null default false;

-- Снимок комплекса на день атлета: [{id, name, unit, sets, target_reps, pick?, chosen?}].
create or replace function public.current_plan(p_athlete uuid, p_date date) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(
           case when s.choice and a.id is not null then
             jsonb_build_object('id', e.id, 'name', e.name, 'unit', e.unit,
               'sets', (x ->> 'sets')::int, 'target_reps', (x ->> 'target_reps')::int,
               'pick', jsonb_build_array(
                 jsonb_build_object('id', e.id, 'name', e.name, 'unit', e.unit, 'target_reps', (x ->> 'target_reps')::int),
                 jsonb_build_object('id', a.id, 'name', a.name, 'unit', a.unit, 'target_reps', (x -> 'alt' ->> 'target_reps')::int)),
               'chosen', null)
           else
             jsonb_build_object('id', e.id, 'name', e.name, 'unit', e.unit,
               'sets', (x ->> 'sets')::int, 'target_reps', (x ->> 'target_reps')::int)
           end order by o), '[]'::jsonb)
  from settings s
  cross join jsonb_array_elements(coalesce(s.complexes -> coalesce(complex_index(p_athlete, p_date), 0), '[]'::jsonb))
         with ordinality as t(x, o)
  join exercises e on e.id = (x ->> 'id')::bigint and not e.archived
  left join exercises a on a.id = (x -> 'alt' ->> 'id')::bigint and not a.archived
  where s.id = 1
$$;

-- Сегодняшний день, где друг ещё ничего не отметил и план не меняли вручную, получает новый план.
-- old — {athlete_id: план до изменения}.
create or replace function public.replan_today(old jsonb) returns void
language sql security definer set search_path = public as $$
  update days d set plan = current_plan(d.athlete_id, app_today()), updated_at = now()
  where d.date = app_today() and d.status = 'training' and d.plan = old -> d.athlete_id::text
    and not exists (select 1 from set_logs s where s.athlete_id = d.athlete_id and s.date = d.date and s.claimed is not null)
$$;

create or replace function public.plans_today() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(p.id::text, current_plan(p.id, app_today())), '{}'::jsonb)
  from profiles p where p.role = 'athlete'
$$;

-- Включить или выключить выбор. Сегодняшний ещё не начатый день сразу получает план в новом виде.
create or replace function public.set_choice(p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  old jsonb;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  old := plans_today();
  update settings set choice = coalesce(p_on, false), updated_at = now() where id = 1;
  perform replan_today(old);
end $$;

-- Как в 0011, плюс второй вариант alt = {id, target_reps} у пункта комплекса.
create or replace function public.save_complexes(p_list jsonb, p_next int) returns void
language plpgsql security definer set search_path = public as $$
declare
  n   int;
  old jsonb;
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
  if exists (select 1 from jsonb_array_elements(p_list) c, jsonb_array_elements(c) x
             where jsonb_typeof(x -> 'alt') = 'object'
               and (not exists (select 1 from exercises e where e.id = (x -> 'alt' ->> 'id')::bigint and not e.archived)
                    or ((x -> 'alt' ->> 'target_reps') is not null and (x -> 'alt' ->> 'target_reps')::int not between 1 and 1000))) then
    raise exception 'Второй вариант: неизвестное упражнение или цель не от 1 до 1000';
  end if;
  if exists (select 1 from jsonb_array_elements(p_list) with ordinality c(v, i), jsonb_array_elements(v) x,
                    lateral (select x ->> 'id' union all select x -> 'alt' ->> 'id' where jsonb_typeof(x -> 'alt') = 'object') u(id)
             group by i, u.id having count(*) > 1) then
    raise exception 'Упражнение повторяется в одном комплексе';
  end if;

  old := plans_today();
  update settings set
    complexes = (select jsonb_agg(coalesce((select jsonb_agg(jsonb_build_object(
                     'id', (x ->> 'id')::bigint, 'sets', (x ->> 'sets')::int, 'target_reps', (x ->> 'target_reps')::int,
                     'alt', case when jsonb_typeof(x -> 'alt') = 'object' then jsonb_build_object(
                              'id', (x -> 'alt' ->> 'id')::bigint, 'target_reps', (x -> 'alt' ->> 'target_reps')::int) end) order by o)
                   from jsonb_array_elements(v) with ordinality t(x, o)), '[]'::jsonb) order by i)
                 from jsonb_array_elements(p_list) with ordinality c(v, i)),
    rotation_from = app_today(), rotation_shift = p_next, updated_at = now()
  where id = 1;
  -- active = упражнение есть хоть в одном комплексе (основным или вторым вариантом).
  update exercises set active = id in (select coalesce((x -> 'alt' ->> 'id')::bigint, -1)
                                       from settings s, jsonb_array_elements(s.complexes) c, jsonb_array_elements(c) x
                                       union all
                                       select (x ->> 'id')::bigint
                                       from settings s, jsonb_array_elements(s.complexes) c, jsonb_array_elements(c) x)
  where true;
  perform replan_today(old);
end $$;

-- Друг выбирает вариант k (0 или 1) в пункте i (с нуля) сегодняшнего плана.
create or replace function public.choose_exercise(p_date date, p_i int, p_k int) returns public.days
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  d   public.days;
  x   jsonb;
  o   jsonb;
begin
  if uid is null then raise exception 'Нужно войти'; end if;
  if p_date is distinct from app_today() then raise exception 'Выбрать можно только на сегодня'; end if;
  perform lock_athlete(uid);
  d := ensure_day(uid, p_date);
  x := d.plan -> p_i;
  o := x -> 'pick' -> p_k;
  if d.status is distinct from 'training' or o is null or jsonb_typeof(o) <> 'object' then
    raise exception 'Тут нечего выбирать';
  end if;
  if exists (select 1 from set_logs s where s.athlete_id = uid and s.date = p_date
             and s.exercise_id = (x ->> 'id')::bigint and s.claimed is not null) then
    raise exception 'Подход уже отмечен — выбор не поменять';
  end if;
  update days set
    plan = jsonb_set(plan, array[p_i::text], x || jsonb_build_object(
      'id', o -> 'id', 'name', o -> 'name', 'unit', o -> 'unit', 'target_reps', o -> 'target_reps', 'chosen', p_k)),
    updated_at = now()
  where athlete_id = uid and date = p_date
  returning * into d;
  return d;
end $$;

-- Как в 0014, только пункты с выбором не заменяются: друг и так выбирает сам.
create or replace function public.swap_items(p_athlete uuid, p_date date, p_ids bigint[]) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'from', x,
           'to', jsonb_build_object('id', t.id, 'name', t.name, 'unit', t.unit, 'sets', (x ->> 'sets')::int,
                                    'target_reps', coalesce(e.swap_target, t.target_reps))) order by o), '[]'::jsonb)
  from days d,
       jsonb_array_elements(coalesce(d.plan, '[]'::jsonb)) with ordinality p(x, o)
  join exercises e on e.id = (x ->> 'id')::bigint
  join exercises t on t.id = e.swap_id and not t.archived
  where d.athlete_id = p_athlete and d.date = p_date
    and (p_athlete = auth.uid() or is_admin())
    and x -> 'from' is null and x -> 'pick' is null
    and (p_ids is null or e.id = any (p_ids))
    and not exists (select 1 from set_logs s where s.athlete_id = p_athlete and s.date = p_date
                    and s.exercise_id = e.id and s.claimed is not null)
$$;


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
  public.buy_phone(), public.save_complexes(jsonb, int), public.complex_schedule(uuid, date, date),
  public.buy_allin(date), public.save_allin(jsonb), public.allin_day(date, uuid),
  public.save_body(numeric, numeric), public.delete_body(uuid, date),
  public.request_swap(bigint[], text), public.decide_swap(bigint, boolean),
  public.set_choice(boolean), public.choose_exercise(date, int, int)
to authenticated;
grant execute on function public.bot_outbox(), public.bot_mark_sent(text) to service_role;
