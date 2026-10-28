-- 0025: «За гранью предела» — ставка кнопкой (+10/+25/+50% к базе), приз без множителя серии.
-- pari_plan отдаёт у каждого упражнения три ставки: сколько раз (вверх до целого) и приз.
-- buy_pari принимает [{n, exercise_id, tier}], число раз считает сама.

-- Сколько раз нужно для ставки: база + tier %, вверх до целого.
create or replace function public.pari_reps(p_base int, p_tier int) returns int
language sql immutable as $$
  select ceil(p_base * (100 + p_tier) / 100.0)::int
$$;

create or replace function public.pari_plan(p_start date) returns json
language plpgsql stable security definer set search_path = public as $$
declare
  uid  uuid := auth.uid();
  r    rules := rules_for(app_today());
  days date[];
begin
  if uid is null then raise exception 'Нужно войти'; end if;
  days := pari_days(uid, p_start);
  return json_build_object('start', p_start, 'price', r.pari_price,
    'prizes', json_build_array(r.pari_p10, r.pari_p25, r.pari_p50),
    'days', (select coalesce(json_agg(json_build_object('n', i, 'date', days[i], 'items',
      (select coalesce(json_agg(json_build_object('id', o.id, 'name', o.name, 'unit', o.unit,
          'target', o.target_reps, 'record', rec, 'base', bb.base,
          'bets', (select json_agg(json_build_object('tier', t, 'reps', pari_reps(bb.base, t), 'prize', pari_prize(r, t))
                                   order by t) from unnest(array[10, 25, 50]) t))), '[]'::json)
       from jsonb_to_recordset(pari_options(uid, days[i])) as o(id bigint, name text, unit text, target_reps int),
            lateral (select pari_record(uid, o.id) as rec) rr,
            lateral (select greatest(rr.rec, coalesce(o.target_reps, 0), 1) as base) bb))
      order by i), '[]'::json) from generate_subscripts(days, 1) i));
end $$;

-- Итог ставки на день. points = приз (серия на него не влияет).
create or replace function public.pari_state(p_athlete uuid, p_date date) returns json
language plpgsql stable security definer set search_path = public as $$
declare
  b     record;
  best  int;
  st    text;
begin
  select * into b from pari_bet_at(p_athlete, p_date);
  if not found then return null; end if;
  select max(coalesce(s.confirmed, s.claimed)) into best from set_logs s
  where s.athlete_id = p_athlete and s.date = p_date and s.exercise_id = b.exercise_id
    and s.review in ('accepted', 'corrected');
  if coalesce(best, 0) >= b.reps then st := 'won';
  elsif exists (select 1 from set_logs s where s.athlete_id = p_athlete and s.date = p_date
                and s.exercise_id = b.exercise_id and s.review = 'pending' and s.claimed >= b.reps) then st := 'check';
  elsif p_date < app_today() then st := 'lost';
  else st := 'wait'; end if;
  return json_build_object('pari_id', b.pari_id, 'n', b.n, 'date', p_date, 'exercise_id', b.exercise_id,
    'name', b.name, 'unit', b.unit, 'reps', b.reps, 'base', b.base, 'pct', b.pct, 'prize', b.prize,
    'best', best, 'state', st, 'points', b.prize, 'test', is_test_day(p_date));
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
                    || 'За гранью предела: ' || (s ->> 'name') || ' ' || (s ->> 'best') || ' при ставке '
                    || (s ->> 'reps') || ' (+' || (s ->> 'pct') || '%)' end);
end $$;

-- Покупка: p_bets = [{n, exercise_id, tier}], tier — 10, 25 или 50.
create or replace function public.buy_pari(p_start date, p_bets jsonb) returns public.pari
language plpgsql security definer set search_path = public as $$
declare
  uid   uuid := auth.uid();
  today date := app_today();
  r     rules := rules_for(app_today());
  days  date[];
  s     int;
  bal   int;
  i     int;
  bet   jsonb;
  o     jsonb;
  base  int;
  tier  int;
  res   pari;
begin
  if uid is null then raise exception 'Нужно войти'; end if;
  if (select role from profiles where id = uid) <> 'athlete' then raise exception 'Покупает атлет'; end if;
  perform lock_athlete(uid);
  if r.pari_price is null then raise exception '«За гранью предела» пока не продаётся'; end if;
  if p_start <= today then raise exception '«За гранью предела» покупается заранее, до начала дня'; end if;
  if p_start > today + 7 then raise exception 'Начать можно не дальше чем через неделю'; end if;
  s := streak_at(uid, today);
  if s < coalesce(r.pari_streak, 0) then
    raise exception '«За гранью предела» открывается при серии от % дней, сейчас %', r.pari_streak, s;
  end if;
  if exists (select 1 from pari where athlete_id = uid and status = 'active' and week_start(start) = week_start(p_start)) then
    raise exception '«За гранью предела» — раз в неделю, на эту неделю уже куплено';
  end if;
  days := pari_days(uid, p_start);
  if cardinality(days) < 3 then raise exception 'Впереди меньше трёх тренировок'; end if;
  for i in 1..3 loop
    if exists (select 1 from pari_bet_at(uid, days[i])) then
      raise exception '% уже в другом пари', bot_day_title(days[i]);
    end if;
    if exists (select 1 from purchases where athlete_id = uid and date = days[i] and status = 'active') then
      raise exception 'На % уже куплено «Всё или ничего» — вместе нельзя', bot_day_title(days[i]);
    end if;
  end loop;
  if jsonb_typeof(p_bets) <> 'array' or jsonb_array_length(p_bets) <> 3 then
    raise exception 'Нужно три ставки — по одной на тренировку';
  end if;
  bal := balance_of(uid);
  if bal < r.pari_price then raise exception 'Не хватает очков: нужно %, на балансе %', r.pari_price, bal; end if;

  insert into pari (athlete_id, start, price) values (uid, p_start, r.pari_price) returning * into res;
  for i in 1..3 loop
    select x into bet from jsonb_array_elements(p_bets) x where (x ->> 'n')::int = i;
    if bet is null then raise exception 'Нет ставки на тренировку %', i; end if;
    select y into o from jsonb_array_elements(pari_options(uid, days[i])) y
    where (y ->> 'id')::bigint = (bet ->> 'exercise_id')::bigint limit 1;
    if o is null then raise exception 'Этого упражнения нет в плане на %', bot_day_title(days[i]); end if;
    tier := (bet ->> 'tier')::int;
    if tier is null or tier not in (10, 25, 50) then
      raise exception '%: ставка только +10%%, +25%% или +50%%', o ->> 'name';
    end if;
    base := greatest(pari_record(uid, (o ->> 'id')::bigint), coalesce((o ->> 'target_reps')::int, 0), 1);
    insert into pari_bets (pari_id, n, exercise_id, name, unit, reps, base, pct, prize)
    values (res.id, i, (o ->> 'id')::bigint, o ->> 'name', coalesce(o ->> 'unit', 'reps'),
            pari_reps(base, tier), base, tier, pari_prize(r, tier));
  end loop;
  insert into ledger (athlete_id, date, kind, amount, note)
  values (uid, p_start, 'purchase', -res.price, 'За гранью предела с ' || bot_day_title(p_start));
  return res;
end $$;
