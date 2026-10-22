-- Трекер тренировок · 0022: цены упражнений — три числа вместо цены места.
-- У каждого упражнения в «Правилах»: rep — за повтор (секунду) до цели, over — за повтор (секунду) сверх цели,
-- cap — сколько повторов (секунд) сверх цели в подходе считается. Бонуса за полный подход больше нет.
-- «Выбор упражнения» больше не ставит цену места: в плане только times и eff, очки × eff.
-- Цены с 22.10: подход в цель — 400, максимум сверх цели +100 (замены по просьбе 300 и +75).
-- Планы и правила до 22.10 считаются как раньше. Повторный запуск безопасен.

-- {times, eff} для места при «Выборе».
create or replace function public.choice_cost(r public.rules, p_times int) returns jsonb
language sql immutable set search_path = public as $$
  select jsonb_build_object('times', coalesce(p_times, 0), 'eff', choice_eff(r, p_times))
$$;

-- Как в 0018, только эффективность ставится при любом включённом «Выборе».
create or replace function public.current_plan(p_athlete uuid, p_date date) returns jsonb
language sql stable security definer set search_path = public as $$
  with rr as (select rules_for(p_date) as rule),
  items as (
    select o, x, e, a, s.choice and a.id is not null as pick,
           s.choice as priced,
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
  eff    numeric;
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
      -- Цена места (планы до 22.10): подход в цель — цена / подходы, меньше — по доле. Сверх цели: +50% к цели в каждом подходе
      -- дают всю разницу top − price, меньше — по доле; подход не больше своей доли, за день по упражнению не выше top.
      per := price / greatest(coalesce((ex ->> 'sets')::int, 1), 1);
      if l.confirmed > 0 then
        base := round(case when target is null or l.confirmed >= target then per else per * l.confirmed / target end);
        if target is not null and l.confirmed > target then
          bon := greatest(0, least(
            round((l.confirmed - target) * (coalesce((ex ->> 'top')::numeric, price) - price)
                  / (greatest(coalesce((ex ->> 'sets')::int, 1), 1) * target * 0.5))::int,
            round((coalesce((ex ->> 'top')::numeric, price) - price)
                  / greatest(coalesce((ex ->> 'sets')::int, 1), 1))::int,
            coalesce((ex ->> 'top')::int, price::int) - price::int - other));
        end if;
      end if;
    elsif pe ? 'set' then
      -- Старые правила (до 22.10): за все повторы, за полный подход и сверх цели с потолком на день.
      base := l.confirmed * coalesce((pe ->> 'rep')::numeric, 0)
            + case when l.confirmed > 0 and (target is null or l.confirmed >= target)
                   then coalesce((pe ->> 'set')::numeric, 0) else 0 end;
      if target is not null and l.confirmed > target and coalesce((pe ->> 'over')::numeric, 0) > 0 then
        bon := round((l.confirmed - target) * (pe ->> 'over')::numeric);
        if (pe ->> 'cap') is not null then
          bon := greatest(0, least(bon, (pe ->> 'cap')::int - other));
        end if;
      end if;
    elsif l.confirmed > 0 then
      -- Повторы до цели по rep, сверх цели по over, но в подходе не больше cap повторов (секунд).
      -- При «Выборе» всё умножается на эффективность (eff, %).
      eff := coalesce((ex ->> 'eff')::numeric, 100) / 100;
      base := least(l.confirmed, coalesce(target, l.confirmed)) * coalesce((pe ->> 'rep')::numeric, 0) * eff;
      if target is not null and l.confirmed > target then
        bon := round(least(l.confirmed - target, coalesce((pe ->> 'cap')::int, l.confirmed))
                     * coalesce((pe ->> 'over')::numeric, 0) * eff);
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

-- Цены с 22.10. Цену места убираем.
update public.rules set choice_price = null, choice_max = null, per_exercise = '{"1": {"rep": 20, "over": 10, "cap": 10}, "2": {"rep": 66.67, "over": 33.33, "cap": 3}, "3": {"rep": 40, "over": 20, "cap": 5}, "5": {"rep": 3.33, "over": 1.67, "cap": 60}, "6": {"rep": 5.71, "over": 2.86, "cap": 35}, "7": {"rep": 40, "over": 20, "cap": 5}, "8": {"rep": 26.67, "over": 12.5, "cap": 8}, "9": {"rep": 33.33, "over": 16.67, "cap": 6}, "10": {"rep": 50, "over": 25, "cap": 4}, "11": {"rep": 40, "over": 20, "cap": 5}, "12": {"rep": 26.67, "over": 12.5, "cap": 8}, "13": {"rep": 20, "over": 9.38, "cap": 8}, "14": {"rep": 16.67, "over": 8.33, "cap": 9}, "15": {"rep": 12, "over": 5.77, "cap": 13}, "16": {"rep": 25, "over": 12.5, "cap": 6}, "17": {"rep": 3.33, "over": 1.67, "cap": 45}, "18": {"rep": 15, "over": 7.5, "cap": 10}, "19": {"rep": 20, "over": 9.38, "cap": 8}, "20": {"rep": 15, "over": 7.5, "cap": 10}, "21": {"rep": 5, "over": 2.5, "cap": 30}, "22": {"rep": 26.67, "over": 12.5, "cap": 8}, "23": {"rep": 8.89, "over": 4.35, "cap": 23}, "24": {"rep": 40, "over": 20, "cap": 5}, "25": {"rep": 26.67, "over": 12.5, "cap": 8}, "26": {"rep": 26.67, "over": 12.5, "cap": 8}, "27": {"rep": 50, "over": 25, "cap": 4}, "28": {"rep": 40, "over": 20, "cap": 5}, "29": {"rep": 16, "over": 7.69, "cap": 13}}'::jsonb
where valid_from = date '2026-10-22';
