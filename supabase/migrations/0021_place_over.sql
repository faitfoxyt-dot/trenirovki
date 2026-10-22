-- Трекер тренировок · 0021: сверх цели при цене места.
-- Раньше каждый повтор сверх цели стоил как повтор в цель, и большой перевыполненный подход сразу добирал максимум.
-- Теперь весь бонус (top − price, при 800/1000 это +200) дают +50% к цели в каждом подходе, меньше — по доле.
-- Один подход не берёт больше своей доли бонуса ((top − price) / подходы), чтобы одинаковые подходы стоили одинаково.
-- Остальное как в 0018. Повторный запуск безопасен.

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
      -- Цена места: подход в цель — цена / подходы, меньше — по доле. Сверх цели: +50% к цели в каждом подходе
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
