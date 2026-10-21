-- Трекер тренировок · 0018: цена места и эффективность при «Выборе упражнения».
-- Когда выбор включён и в «Правилах» задана цена (choice_price), все упражнения стоят одинаково:
-- все подходы в цель — choice_price, меньше цели — по доле, каждый повтор сверх цели — как повтор в цель,
-- но за упражнение в день не больше choice_max. Друг берёт то же самое в этом месте подряд —
-- эффективность каждый раз минус choice_drop % (100 → 90 → 80 …), не ниже choice_floor %; обе цифры умножаются на неё.
-- Взял другой вариант — снова 100%. Где выбора нет — 100%. Замена по просьбе — 75%.
-- Цена снимается в план дня: price, top, times (сколько раз подряд брал), eff (%). Очки считаются по плану,
-- поэтому правка правил не меняет уже начатый день. Пустая цена — всё по ценам упражнений, как раньше.
-- Повторный запуск безопасен.

alter table public.rules add column if not exists choice_price int check (choice_price >= 1);
alter table public.rules add column if not exists choice_max int check (choice_max >= 1);
alter table public.rules add column if not exists choice_drop numeric check (choice_drop between 0 and 100);
alter table public.rules add column if not exists choice_floor numeric check (choice_floor between 0 and 100);

-- Эффективность, %: минус choice_drop за каждый раз подряд, не ниже choice_floor.
create or replace function public.choice_eff(r public.rules, p_times int) returns numeric
language sql immutable set search_path = public as $$
  select greatest(coalesce(r.choice_floor, 0), 100 - coalesce(r.choice_drop, 0) * coalesce(p_times, 0))
$$;

-- {price, top, times, eff} для места; null — цены места нет.
create or replace function public.choice_cost(r public.rules, p_times int) returns jsonb
language sql immutable set search_path = public as $$
  select case when r.choice_price is not null then jsonb_build_object(
    'price', round(r.choice_price * choice_eff(r, p_times) / 100)::int,
    'top', greatest(round(r.choice_price * choice_eff(r, p_times) / 100),
                    round(coalesce(r.choice_max, r.choice_price) * choice_eff(r, p_times) / 100))::int,
    'times', coalesce(p_times, 0),
    'eff', choice_eff(r, p_times)) end
$$;

-- Сколько раз подряд друг брал вариант p_id в месте с парой p_pair (id через «-» по возрастанию):
-- идём по прошлым дням назад. Не выбрал и ничего не отметил — день не считаем;
-- не выбрал, но отмечал — это первый вариант; взял другой — цепочка кончилась.
-- Без security definer: изнутри current_plan видит всё, а снаружи — только то, что пускают права на days.
create or replace function public.choice_times(p_athlete uuid, p_date date, p_pair text, p_id bigint) returns int
language plpgsql stable set search_path = public as $$
declare
  n    int := 0;
  x    jsonb;
  dd   date;
  took bigint;
begin
  for dd, x in
    select d.date, it from days d, jsonb_array_elements(d.plan) it
    where d.athlete_id = p_athlete and d.date < p_date and jsonb_typeof(d.plan) = 'array'
      and jsonb_typeof(it -> 'pick') = 'array'
      and (select string_agg(o ->> 'id', '-' order by (o ->> 'id')::bigint) from jsonb_array_elements(it -> 'pick') o) = p_pair
    order by d.date desc
  loop
    if jsonb_typeof(x -> 'chosen') = 'number' then
      took := (x -> 'pick' -> (x ->> 'chosen')::int ->> 'id')::bigint;
    elsif exists (select 1 from set_logs s where s.athlete_id = p_athlete and s.date = dd
                  and s.exercise_id = (x ->> 'id')::bigint and s.claimed is not null) then
      took := (x ->> 'id')::bigint;
    else
      continue;
    end if;
    exit when took is distinct from p_id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Как в 0015, плюс цена места у пункта и у каждого варианта.
create or replace function public.current_plan(p_athlete uuid, p_date date) returns jsonb
language sql stable security definer set search_path = public as $$
  with rr as (select rules_for(p_date) as rule),
  items as (
    select o, x, e, a, s.choice and a.id is not null as pick,
           s.choice and (select (rule).choice_price from rr) is not null as priced,
           (select string_agg(i::text, '-' order by i) from unnest(array[e.id, a.id]) i) as pair
    from settings s
    cross join jsonb_array_elements(coalesce(s.complexes -> coalesce(complex_index(p_athlete, p_date), 0), '[]'::jsonb))
           with ordinality as t(x, o)
    join exercises e on e.id = (x ->> 'id')::bigint and not e.archived
    left join exercises a on a.id = (x -> 'alt' ->> 'id')::bigint and not a.archived
    where s.id = 1
  ),
  opts as (
    select i.*,
      jsonb_build_object('id', (i.e).id, 'name', (i.e).name, 'unit', (i.e).unit, 'target_reps', (i.x ->> 'target_reps')::int)
        || case when i.priced then coalesce(choice_cost((select rule from rr),
             case when i.pick then choice_times(p_athlete, p_date, i.pair, (i.e).id) else 0 end), '{}') else '{}' end as o1,
      case when i.pick then
        jsonb_build_object('id', (i.a).id, 'name', (i.a).name, 'unit', (i.a).unit, 'target_reps', (i.x -> 'alt' ->> 'target_reps')::int)
        || case when i.priced then coalesce(choice_cost((select rule from rr),
             choice_times(p_athlete, p_date, i.pair, (i.a).id)), '{}') else '{}' end end as o2
    from items i
  )
  select coalesce(jsonb_agg(
           case when pick then o1 || jsonb_build_object('sets', (x ->> 'sets')::int, 'pick', jsonb_build_array(o1, o2), 'chosen', null)
           else o1 || jsonb_build_object('sets', (x ->> 'sets')::int) end order by o), '[]'::jsonb)
  from opts
$$;

-- Как в 0015, плюс цена выбранного варианта переходит в пункт плана.
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
    plan = jsonb_set(plan, array[p_i::text], (x - 'price' - 'top' - 'times' - 'eff') || jsonb_build_object(
      'id', o -> 'id', 'name', o -> 'name', 'unit', o -> 'unit', 'target_reps', o -> 'target_reps', 'chosen', p_k)
      || jsonb_strip_nulls(jsonb_build_object('price', o -> 'price', 'top', o -> 'top', 'times', o -> 'times', 'eff', o -> 'eff'))),
    updated_at = now()
  where athlete_id = uid and date = p_date
  returning * into d;
  return d;
end $$;

-- Как в 0014, плюс замена по цене места стоит 75% того, что стоило упражнение.
create or replace function public.decide_swap(p_id bigint, p_approve boolean) returns public.swap_requests
language plpgsql security definer set search_path = public as $$
declare
  r     public.swap_requests;
  items jsonb;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  select * into r from swap_requests where id = p_id for update;
  if not found then raise exception 'Запрос не найден'; end if;
  if r.status <> 'pending' then raise exception 'Запрос уже решён'; end if;
  if p_approve then
    if r.date < app_today() then raise exception 'День уже закончился'; end if;
    items := swap_items(r.athlete_id, r.date, r.exercise_ids);
    if jsonb_array_length(items) = 0 then raise exception 'Менять уже нечего: подходы отмечены'; end if;
    update days d set plan = (
      select jsonb_agg(coalesce(
               (select i -> 'to' || jsonb_build_object('from', x)
                       || case when jsonb_typeof(x -> 'price') = 'number' then jsonb_build_object(
                            'price', round((x ->> 'price')::numeric * 0.75)::int,
                            'top', round(coalesce((x ->> 'top')::numeric, (x ->> 'price')::numeric) * 0.75)::int,
                            'times', 0,
                            'eff', round(coalesce((x ->> 'eff')::numeric, 100) * 0.75)) else '{}' end
                from jsonb_array_elements(items) i
                 where (i -> 'from' ->> 'id') = (x ->> 'id')), x) order by o)
      from jsonb_array_elements(d.plan) with ordinality p(x, o)), updated_at = now()
    where d.athlete_id = r.athlete_id and d.date = r.date;
  end if;
  update swap_requests set status = case when p_approve then 'approved' else 'declined' end::public.request_status,
                           decided_at = now()
  where id = p_id returning * into r;
  return r;
end $$;

-- Как в 0008, плюс очки по цене места, если она есть в плане дня.
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
  price  numeric;
  per    numeric;
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
  price := (ex ->> 'price')::numeric;

  if ok then
    if cal then
      select coalesce(sum(t.bonus), 0) into other from theory_points t join set_logs s on s.id = t.set_id
      where t.athlete_id = l.athlete_id and t.date = l.date and s.exercise_id = l.exercise_id and t.set_id <> l.id;
    else
      select coalesce(sum(bonus), 0) into other from set_logs
      where athlete_id = l.athlete_id and date = l.date and exercise_id = l.exercise_id and id <> l.id;
    end if;
    if price is not null then
      -- Цена места: подход в цель — цена / подходы, меньше — по доле, сверх цели — как повтор в цель, но не выше top.
      per := price / greatest(coalesce((ex ->> 'sets')::int, 1), 1);
      if l.confirmed > 0 then
        base := round(case when target is null or l.confirmed >= target then per else per * l.confirmed / target end);
        if target is not null and l.confirmed > target then
          bon := greatest(0, least(round((l.confirmed - target) * per / target)::int,
                                   coalesce((ex ->> 'top')::int, price::int) - price::int - other));
        end if;
      end if;
    else
      base := l.confirmed * coalesce((pe ->> 'rep')::numeric, 0)
            + case when l.confirmed > 0 and (target is null or l.confirmed >= target)
                   then coalesce((pe ->> 'set')::numeric, 0) else 0 end;
      if target is not null and l.confirmed > target and coalesce((pe ->> 'over')::numeric, 0) > 0 then
        bon := round((l.confirmed - target) * (pe ->> 'over')::numeric);
        if (pe ->> 'cap') is not null then
          bon := greatest(0, least(bon, (pe ->> 'cap')::int - other));
        end if;
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

-- Как в 0006, плюс поля «Всё или ничего» и цены места сохраняются и при повторном сохранении за день,
-- а сегодняшний ещё не начатый день получает план с новой ценой.
create or replace function public.save_rules(p jsonb) returns public.rules
language plpgsql security definer set search_path = public as $$
declare
  r   public.rules;
  old jsonb;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  old := plans_today();
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
    phone_price = excluded.phone_price, saved_at = excluded.saved_at,
    allin_price = case when p ? 'allin_price' then excluded.allin_price else rules.allin_price end,
    allin_up = case when p ? 'allin_up' then excluded.allin_up else rules.allin_up end,
    allin_down = case when p ? 'allin_down' then excluded.allin_down else rules.allin_down end,
    allin_limit_week = case when p ? 'allin_limit_week' then excluded.allin_limit_week else rules.allin_limit_week end,
    choice_price = case when p ? 'choice_price' then excluded.choice_price else rules.choice_price end,
    choice_max = case when p ? 'choice_max' then excluded.choice_max else rules.choice_max end,
    choice_drop = case when p ? 'choice_drop' then excluded.choice_drop else rules.choice_drop end,
    choice_floor = case when p ? 'choice_floor' then excluded.choice_floor else rules.choice_floor end
  returning * into r;
  perform award_set(s.id) from set_logs s
  where s.date > app_today() - 60 and s.review in ('accepted', 'corrected')
    and (coalesce((rules_for(s.date)).calibration, true)
         or exists (select 1 from theory_points t where t.set_id = s.id));
  perform replan_today(old);
  return r;
end $$;
