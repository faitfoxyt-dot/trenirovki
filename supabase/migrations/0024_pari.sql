-- Трекер тренировок · 0024: «За гранью предела» — пари с генералом на 3 тренировки.
-- Открывается серией (rules.pari_streak, по умолчанию 10), ALL IN — серией rules.allin_streak (5).
-- Покупка раз в неделю, заранее, начало не дальше недели вперёд. Пари идёт на 3 тренировочных дня
-- подряд начиная с выбранного: на каждый день — одно упражнение из плана и число за один подход.
-- Дни пари считаются вживую (pari_days): если день стал больничным, ставка переезжает на следующую
-- тренировку вместе с комплексом. База = рекорд (лучший проверенный подход), но не меньше цели.
-- Ставка минимум на 10% выше базы; приз по ставке: +10% / +25% / +50% → pari_p10 / pari_p25 / pari_p50,
-- умножается на серию этого дня. Сделал — приз (ledger kind 'pari'), не сделал — приза нет,
-- обычные очки остаются. Подход, который выигрывает ставку, бот сам не принимает — его смотрит генерал.
-- В дни пари нельзя ALL IN и выходной. Тестовый период — только показ, без очков.
-- Повторный запуск безопасен.

alter type public.ledger_kind add value if not exists 'pari';

alter table public.rules add column if not exists allin_streak int;
alter table public.rules add column if not exists pari_streak int;
alter table public.rules add column if not exists pari_price int;
alter table public.rules add column if not exists pari_p10 int;
alter table public.rules add column if not exists pari_p25 int;
alter table public.rules add column if not exists pari_p50 int;

-- Стартовые числа в действующие правила (если ещё не заданы).
update public.rules set
  allin_streak = coalesce(allin_streak, 5), pari_streak = coalesce(pari_streak, 10),
  pari_price = coalesce(pari_price, 5000), pari_p10 = coalesce(pari_p10, 2500),
  pari_p25 = coalesce(pari_p25, 3500), pari_p50 = coalesce(pari_p50, 5000)
where valid_from = (select max(valid_from) from public.rules);

create table if not exists public.pari (
  id           bigint generated always as identity primary key,
  athlete_id   uuid not null references public.profiles (id),
  start        date not null,
  price        int not null,
  status       public.purchase_status not null default 'active',
  created_at   timestamptz not null default now(),
  cancelled_at timestamptz
);

create table if not exists public.pari_bets (
  pari_id     bigint not null references public.pari (id),
  n           int not null check (n between 1 and 3),  -- какая по счёту тренировка пари
  exercise_id bigint not null references public.exercises (id),
  name        text not null,
  unit        text not null default 'reps',
  reps        int not null check (reps > 0),            -- ставка: столько за один подход
  base        int not null,                             -- рекорд, но не меньше цели (на момент покупки)
  pct         int not null,                             -- на сколько % ставка выше базы
  prize       int not null,
  primary key (pari_id, n)
);

alter table public.pari enable row level security;
alter table public.pari_bets enable row level security;
do $$ begin
  create policy "свои или админ" on public.pari
    for select to authenticated using (athlete_id = auth.uid() or public.is_admin());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "свои или админ" on public.pari_bets
    for select to authenticated using (exists (select 1 from public.pari p where p.id = pari_id
                                               and (p.athlete_id = auth.uid() or public.is_admin())));
exception when duplicate_object then null; end $$;

-- ───────────── Функции ─────────────

-- 3 тренировочных дня пари, начиная со start (не дальше 3 недель).
create or replace function public.pari_days(p_athlete uuid, p_start date) returns date[]
language plpgsql stable security definer set search_path = public as $$
declare
  d   date := p_start;
  res date[] := '{}';
begin
  while cardinality(res) < 3 and d < p_start + 21 loop
    if day_status_of(p_athlete, d) = 'training' then res := res || d; end if;
    d := d + 1;
  end loop;
  return res;
end $$;

-- Лучший проверенный подход в упражнении за всё время (0 — ещё не делал).
create or replace function public.pari_record(p_athlete uuid, p_exercise bigint) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(max(coalesce(s.confirmed, s.claimed)), 0)::int from set_logs s
  where s.athlete_id = p_athlete and s.exercise_id = p_exercise and s.review in ('accepted', 'corrected')
$$;

-- Упражнения дня, на которые можно спорить: всё из плана, у мест с выбором — оба варианта.
create or replace function public.pari_options(p_athlete uuid, p_date date) returns jsonb
language sql stable security definer set search_path = public as $$
  with plan as (
    select coalesce((select d.plan from days d where d.athlete_id = p_athlete and d.date = p_date),
                    current_plan(p_athlete, p_date)) as p
  ), o as (
    select coalesce(x -> 'pick', jsonb_build_array(x)) as opts from plan, jsonb_array_elements(plan.p) x
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', (y ->> 'id')::bigint, 'name', y ->> 'name',
           'unit', coalesce(y ->> 'unit', 'reps'), 'target_reps', (y ->> 'target_reps')::int)), '[]'::jsonb)
  from o, jsonb_array_elements(o.opts) y
$$;

-- Приз за ставку: на сколько % выше базы → приз по правилам (0 — меньше +10%).
create or replace function public.pari_prize(r rules, p_pct int) returns int
language sql immutable as $$
  select case when p_pct >= 50 then coalesce(r.pari_p50, 0)
              when p_pct >= 25 then coalesce(r.pari_p25, 0)
              when p_pct >= 10 then coalesce(r.pari_p10, 0) else 0 end
$$;

-- Что можно поставить, если начать пари с p_start: 3 дня, в каждом упражнения с базой и минимумом.
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
          'target', o.target_reps, 'record', rec, 'base', greatest(rec, coalesce(o.target_reps, 0), 1),
          'min', ceil(greatest(rec, coalesce(o.target_reps, 0), 1) * 1.1)::int)), '[]'::json)
       from jsonb_to_recordset(pari_options(uid, days[i])) as o(id bigint, name text, unit text, target_reps int),
            lateral (select pari_record(uid, o.id) as rec) rr))
      order by i), '[]'::json) from generate_subscripts(days, 1) i));
end $$;

-- Ставка пари на этот день (если день — одна из 3 тренировок действующего пари).
create or replace function public.pari_bet_at(p_athlete uuid, p_date date)
returns table (pari_id bigint, n int, exercise_id bigint, name text, unit text, reps int, base int, pct int, prize int)
language plpgsql stable security definer set search_path = public as $$
declare
  p pari;
  i int;
begin
  for p in select * from pari x where x.athlete_id = p_athlete and x.status = 'active'
             and x.start <= p_date and x.start > p_date - 21 order by x.start loop
    i := array_position(pari_days(p_athlete, p.start), p_date);
    if i is not null then
      return query select b.pari_id, b.n, b.exercise_id, b.name, b.unit, b.reps, b.base, b.pct, b.prize
                   from pari_bets b where b.pari_id = p.id and b.n = i;
      return;
    end if;
  end loop;
end $$;

-- Итог ставки на день: wait — ещё впереди или идёт, check — на проверке у генерала, won, lost.
create or replace function public.pari_state(p_athlete uuid, p_date date) returns json
language plpgsql stable security definer set search_path = public as $$
declare
  b     record;
  best  int;
  st    text;
  mult  numeric;
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
  mult := streak_mult(rules_for(p_date), day_streak(p_athlete, p_date));
  return json_build_object('pari_id', b.pari_id, 'n', b.n, 'date', p_date, 'exercise_id', b.exercise_id,
    'name', b.name, 'unit', b.unit, 'reps', b.reps, 'base', b.base, 'pct', b.pct, 'prize', b.prize,
    'best', best, 'state', st, 'mult', trim_scale(round(mult, 2)), 'points', round(b.prize * mult)::int,
    'test', is_test_day(p_date));
end $$;

-- Приз в журнал: разница между тем, что положено, и тем, что уже записано (и откат).
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
                    || (s ->> 'reps') || ' · приз ' || (s ->> 'prize') || ' ×' || (s ->> 'mult') end);
end $$;

-- Покупка: p_bets = [{n, exercise_id, reps}] на 3 тренировки начиная с p_start.
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
  rec   int;
  base  int;
  reps  int;
  pct   int;
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
    reps := (bet ->> 'reps')::int;
    rec := pari_record(uid, (o ->> 'id')::bigint);
    base := greatest(rec, coalesce((o ->> 'target_reps')::int, 0), 1);
    if reps is null or reps < ceil(base * 1.1) then
      raise exception '%: ставка минимум %', o ->> 'name', ceil(base * 1.1)::int;
    end if;
    pct := floor(reps * 100.0 / base - 100)::int;
    insert into pari_bets (pari_id, n, exercise_id, name, unit, reps, base, pct, prize)
    values (res.id, i, (o ->> 'id')::bigint, o ->> 'name', coalesce(o ->> 'unit', 'reps'), reps, base, pct, pari_prize(r, pct));
  end loop;
  insert into ledger (athlete_id, date, kind, amount, note)
  values (uid, p_start, 'purchase', -res.price, 'За гранью предела с ' || bot_day_title(p_start));
  return res;
end $$;

-- Отмена до начала первого дня пари: очки возвращаются.
create or replace function public.cancel_pari(p_id bigint) returns public.pari
language plpgsql security definer set search_path = public as $$
declare
  p   pari;
begin
  if auth.uid() is null then raise exception 'Нужно войти'; end if;
  select * into p from pari where id = p_id;
  if not found or (p.athlete_id <> auth.uid() and not is_admin()) then raise exception 'Пари не найдено'; end if;
  perform lock_athlete(p.athlete_id);
  select * into p from pari where id = p_id for update;
  if p.status = 'cancelled' then raise exception 'Пари уже отменено'; end if;
  if p.start <= app_today() then raise exception 'Отменить можно только до начала первого дня'; end if;
  update pari set status = 'cancelled', cancelled_at = now() where id = p_id returning * into p;
  insert into ledger (athlete_id, date, kind, amount, note)
  values (p.athlete_id, p.start, 'refund', p.price, 'Отмена «За гранью предела» с ' || bot_day_title(p.start));
  return p;
end $$;

-- Пари атлета (своё или, админу, любого), начатые не раньше p_from: дни, ставки и итоги.
create or replace function public.pari_list(p_from date, p_athlete uuid default null) returns json
language plpgsql security definer set search_path = public as $$
declare
  who uuid := coalesce(p_athlete, auth.uid());
begin
  if auth.uid() is null then raise exception 'Нужно войти'; end if;
  if who <> auth.uid() and not is_admin() then raise exception 'Нет доступа'; end if;
  return (select coalesce(json_agg(json_build_object('id', p.id, 'start', p.start, 'price', p.price,
      'status', p.status, 'days', pari_days(who, p.start),
      'bets', (select json_agg(case when p.status = 'active' then
                 coalesce(pari_state(who, (pari_days(who, p.start))[b.n]),
                          json_build_object('n', b.n, 'name', b.name, 'reps', b.reps, 'prize', b.prize, 'state', 'wait'))
               else json_build_object('n', b.n, 'name', b.name, 'unit', b.unit, 'reps', b.reps, 'prize', b.prize,
                                      'state', 'cancelled') end order by b.n)
               from pari_bets b where b.pari_id = p.id)) order by p.start), '[]'::json)
    from pari p where p.athlete_id = who and p.start >= p_from);
end $$;

-- Ставка на день для «Сегодня» и «Проверки».
create or replace function public.pari_day(p_date date, p_athlete uuid default null) returns json
language plpgsql stable security definer set search_path = public as $$
declare
  who uuid := coalesce(p_athlete, auth.uid());
begin
  if auth.uid() is null then raise exception 'Нужно войти'; end if;
  if who <> auth.uid() and not is_admin() then raise exception 'Нет доступа'; end if;
  return pari_state(who, p_date);
end $$;

-- Сохранение настроек магазина после save_rules: ALL IN и «За гранью предела».
create or replace function public.save_allin(p jsonb) returns rules
language plpgsql security definer set search_path = public as $$
declare
  r public.rules;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  update rules set
    allin_price = (p ->> 'allin_price')::int, allin_up = (p ->> 'allin_up')::numeric,
    allin_down = (p ->> 'allin_down')::numeric, allin_limit_week = (p ->> 'allin_limit_week')::int,
    allin_streak = case when p ? 'allin_streak' then (p ->> 'allin_streak')::int else allin_streak end,
    pari_streak = case when p ? 'pari_streak' then (p ->> 'pari_streak')::int else pari_streak end,
    pari_price = case when p ? 'pari_price' then (p ->> 'pari_price')::int else pari_price end,
    pari_p10 = case when p ? 'pari_p10' then (p ->> 'pari_p10')::int else pari_p10 end,
    pari_p25 = case when p ? 'pari_p25' then (p ->> 'pari_p25')::int else pari_p25 end,
    pari_p50 = case when p ? 'pari_p50' then (p ->> 'pari_p50')::int else pari_p50 end
  where valid_from = app_today()
  returning * into r;
  if not found then raise exception 'Сначала сохрани правила'; end if;
  return r;
end $$;

-- ALL IN: порог серии из правил, не дальше недели, не в день пари.
create or replace function public.buy_allin(p_date date) returns public.purchases
language plpgsql security definer set search_path = public as $$
declare
  uid   uuid := auth.uid();
  today date := app_today();
  r     public.rules := rules_for(app_today());
  s     int;
  cnt   int;
  bal   int;
  res   public.purchases;
begin
  if uid is null then raise exception 'Нужно войти'; end if;
  if (select role from profiles where id = uid) <> 'athlete' then raise exception 'Покупает атлет'; end if;
  perform lock_athlete(uid);
  if p_date <= today then raise exception '«Всё или ничего» покупается заранее, до начала дня'; end if;
  if p_date > today + 7 then raise exception '«Всё или ничего» можно купить не дальше чем на неделю вперёд'; end if;
  if r.allin_price is null then raise exception 'Цену «Всё или ничего» Тимур ещё не задал'; end if;
  s := streak_at(uid, today);
  if s < coalesce(r.allin_streak, 0) then
    raise exception '«Всё или ничего» открывается при серии от % дней, сейчас %', r.allin_streak, s;
  end if;
  if day_status_of(uid, p_date) is distinct from 'training' then raise exception 'В этот день нет тренировки'; end if;
  if exists (select 1 from purchases where athlete_id = uid and date = p_date and status = 'active') then
    raise exception 'На этот день уже есть покупка';
  end if;
  if exists (select 1 from pari_bet_at(uid, p_date)) then
    raise exception 'В этот день идёт «За гранью предела» — вместе нельзя';
  end if;
  if r.allin_limit_week is not null then
    select count(*) into cnt from purchases
    where athlete_id = uid and status = 'active' and kind = 'allin' and week_start(date) = week_start(p_date);
    if cnt >= r.allin_limit_week then
      raise exception 'На этой неделе лимит «Всё или ничего»: %', r.allin_limit_week;
    end if;
  end if;
  bal := balance_of(uid);
  if bal < r.allin_price then
    raise exception 'Не хватает очков: нужно %, на балансе %', r.allin_price, bal;
  end if;

  insert into purchases (athlete_id, date, price, prev_status, kind)
  values (uid, p_date, r.allin_price, 'training', 'allin') returning * into res;
  insert into ledger (athlete_id, date, kind, amount, note)
  values (uid, p_date, 'purchase', -res.price, 'Всё или ничего на ' || bot_day_title(p_date));
  return res;
end $$;

-- Выходной: как было, плюс нельзя в день пари.
create or replace function public.buy_rest_day(p_date date) returns public.purchases
language plpgsql security definer set search_path = public as $$
declare
  uid   uuid := auth.uid();
  today date := app_today();
  r     public.rules := rules_for(app_today());
  cnt   int;
  bal   int;
  st    public.day_status;
  res   public.purchases;
begin
  if uid is null then raise exception 'Нужно войти'; end if;
  if (select role from profiles where id = uid) <> 'athlete' then raise exception 'Выходной покупает атлет'; end if;
  perform lock_athlete(uid);
  if p_date <= today then raise exception 'Выходной покупается заранее, до начала дня'; end if;
  if p_date > today + 60 then raise exception 'Можно купить не дальше чем на 60 дней вперёд'; end if;
  if r.rest_day_price is null then raise exception 'Цену выходного Тимур ещё не задал'; end if;
  st := day_status_of(uid, p_date);
  if st is distinct from 'training' then raise exception 'В этот день и так нет тренировки'; end if;
  if exists (select 1 from purchases where athlete_id = uid and date = p_date and status = 'active') then
    raise exception 'На этот день уже куплено «Всё или ничего». Отмени его, если хочешь выходной';
  end if;
  if exists (select 1 from pari_bet_at(uid, p_date)) then
    raise exception 'В этот день идёт «За гранью предела» — выходной не купить';
  end if;
  if r.purchase_limit_week is not null then
    select count(*) into cnt from purchases
    where athlete_id = uid and status = 'active' and kind = 'rest'
      and week_start(date) = week_start(p_date);
    if cnt >= r.purchase_limit_week then
      raise exception 'На этой неделе лимит: % вых.', r.purchase_limit_week;
    end if;
  end if;
  bal := balance_of(uid);
  if bal < r.rest_day_price then
    raise exception 'Не хватает очков: нужно %, на балансе %', r.rest_day_price, bal;
  end if;

  insert into purchases (athlete_id, date, price, prev_status, kind)
  values (uid, p_date, r.rest_day_price, st, 'rest') returning * into res;
  insert into days (athlete_id, date, status) values (uid, p_date, 'bought')
  on conflict (athlete_id, date) do update set status = 'bought', updated_at = now();
  insert into ledger (athlete_id, date, kind, amount, note)
  values (uid, p_date, 'purchase', -res.price, 'Выходной на ' || bot_day_title(p_date));
  return res;
end $$;

-- Видео от бота: подход, который выигрывает ставку пари, бот не принимает — только прикрепляет видео.
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
  if l.review <> 'pending'
     or exists (select 1 from pari_bet_at(l.athlete_id, l.date) b
                where b.exercise_id = l.exercise_id and l.claimed >= b.reps) then
    -- Генерал уже решил сам или это подход на ставку — только прикрепляем видео.
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

-- settle: как было, плюс призы пари (и откат, если ставку пересмотрели).
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
  ad    date;
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

  -- «Всё или ничего»: итог дня, когда он закончился и всё проверено (и откат, если покупку отменили).
  for ad in select distinct p.date from purchases p
            where p.athlete_id = p_athlete and p.kind = 'allin' and p.date < today and p.date >= today - 60 loop
    perform allin_apply(p_athlete, ad);
  end loop;

  -- Событие дня: бонус мини-игры поверх всего дня (и откат, если событие убрали).
  for ad in select e.date from day_events e
            where e.athlete_id = p_athlete and e.date < today and e.date >= today - 60
            union
            select l.date from ledger l
            where l.athlete_id = p_athlete and l.kind = 'event' and l.date >= today - 60 loop
    perform event_apply(p_athlete, ad);
  end loop;

  -- «За гранью предела»: приз, как только подход на ставку проверен (и откат, если пересмотрели).
  for ad in select unnest(pari_days(p_athlete, p.start)) from pari p
            where p.athlete_id = p_athlete and p.start <= today and p.start >= today - 60
            union
            select l.date from ledger l
            where l.athlete_id = p_athlete and l.kind = 'pari' and l.date >= today - 60 loop
    if ad <= today then perform pari_apply(p_athlete, ad); end if;
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

-- ───────────── Права ─────────────

grant execute on function public.pari_plan(date), public.buy_pari(date, jsonb), public.cancel_pari(bigint),
  public.pari_list(date, uuid), public.pari_day(date, uuid) to authenticated;
