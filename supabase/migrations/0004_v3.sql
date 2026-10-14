-- Трекер тренировок · v3: очки, серия, штраф, цель-телефон, магазин выходных, больничный, идеи.
-- Применять один раз целиком в Supabase → SQL Editor и сразу смёржить PR v3:
-- старый сайт ещё ищет калибровку в settings, а она переезжает в rules.
--
-- Все числа — в таблице rules. Пока Тимур их не задал, идёт калибровка и очки не считаются.
-- Новые правила действуют со следующего дня; очки фиксируются в момент проверки.

-- ───────────── Правила с датой начала ─────────────

create table public.rules (
  valid_from          date primary key,             -- с этого дня действуют
  calibration         boolean not null default true,
  points_per_rep      numeric check (points_per_rep >= 0),
  points_per_set      numeric check (points_per_set >= 0),       -- за подход не меньше цели
  streak_from         int check (streak_from >= 1),              -- с какого дня серии растёт множитель
  streak_step         numeric check (streak_step >= 0),
  streak_max          numeric check (streak_max >= 1),
  bonus_growth        int check (bonus_growth >= 0),             -- за упражнение, где лучший подход недели вырос
  bonus_over          numeric check (bonus_over >= 0),           -- за повтор сверх цели
  bonus_cap_day       int check (bonus_cap_day >= 0),            -- потолок бонуса сверх цели за день
  miss_penalty        int check (miss_penalty >= 0),
  rest_day_price      int check (rest_day_price >= 1),
  purchase_limit_week int check (purchase_limit_week >= 0),     -- пусто = без лимита
  phone_price         int check (phone_price >= 1),
  saved_at            timestamptz not null default now()
);

-- Калибровка переезжает из settings в rules; остальные поля очков в settings были пустыми.
insert into public.rules (valid_from, calibration)
select '2000-01-01', calibration from public.settings where id = 1;

alter table public.settings
  drop column calibration,
  drop column points_per_rep,
  drop column points_per_set,
  drop column streak,
  drop column bonuses,
  drop column miss_penalty,
  drop column rest_day_price,
  drop column purchase_limit_week,
  drop column phone_price;

-- ───────────── Очки, покупки, больничный, идеи ─────────────

create type public.ledger_kind as enum ('set', 'bonus_growth', 'penalty', 'purchase', 'refund', 'milestone');
create type public.purchase_status as enum ('active', 'cancelled');
create type public.request_status as enum ('pending', 'approved', 'declined');
create type public.idea_status as enum ('new', 'accepted', 'declined');

alter table public.set_logs add column bonus int;  -- бонус за повторы сверх цели; points — за подход с серией

-- Журнал очков. Баланс = сумма amount, рейтинг = сумма rating.
create table public.ledger (
  id         bigint generated always as identity primary key,
  athlete_id uuid not null references public.profiles (id) on delete cascade,
  date       date not null,                       -- день, к которому относится запись
  kind       public.ledger_kind not null,
  amount     int not null default 0,              -- баланс (кошелёк)
  rating     int not null default 0,              -- рейтинг: только заработанное
  note       text,
  key        text,                                -- разовые записи: 'penalty:2026-10-20', 'milestone:25'
  set_id     bigint references public.set_logs (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (athlete_id, key)
);
create index ledger_by_athlete on public.ledger (athlete_id, id desc);

create table public.purchases (
  id           bigint generated always as identity primary key,
  athlete_id   uuid not null references public.profiles (id) on delete cascade,
  date         date not null,
  price        int not null,
  prev_status  public.day_status,                 -- что было в этот день до покупки
  status       public.purchase_status not null default 'active',
  created_at   timestamptz not null default now(),
  cancelled_at timestamptz
);
create unique index purchases_one_active on public.purchases (athlete_id, date) where status = 'active';

create table public.sick_requests (
  id         bigint generated always as identity primary key,
  athlete_id uuid not null references public.profiles (id) on delete cascade,
  date       date not null,
  note       text check (note is null or length(note) <= 300),
  status     public.request_status not null default 'pending',
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (athlete_id, date)
);

create table public.ideas (
  id         bigint generated always as identity primary key,
  athlete_id uuid not null references public.profiles (id) on delete cascade,
  text       text not null check (length(trim(text)) between 1 and 300),
  status     public.idea_status not null default 'new',
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

-- ───────────── Помощники ─────────────

-- Правила, которые действуют в этот день. Если строк нет — калибровка.
create function public.rules_for(p_date date) returns public.rules
language sql stable security definer set search_path = public as $$
  select * from rules where valid_from <= p_date order by valid_from desc limit 1
$$;

-- Статус дня: своя строка дня, иначе шаблон недели.
create function public.day_status_of(p_athlete uuid, p_date date) returns public.day_status
language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from days where athlete_id = p_athlete and date = p_date)
      then (select status from days where athlete_id = p_athlete and date = p_date)
    else (select status from week_template where dow = extract(isodow from p_date)) end
$$;

create function public.balance_of(p_athlete uuid) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount), 0)::int from ledger where athlete_id = p_athlete
$$;

create function public.rating_of(p_athlete uuid) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(sum(rating), 0)::int from ledger where athlete_id = p_athlete
$$;

-- Серия на этот день: тренировочные дни подряд, где есть хоть одна отметка.
-- Выходные, купленные, больничные и «занят» серию не рвут и не добавляют.
-- Сегодняшний день без отметок серию не рвёт: он ещё не закончился.
create function public.streak_at(p_athlete uuid, p_date date) returns int
language plpgsql stable security definer set search_path = public as $$
declare
  start date := (select start_date from settings where id = 1);
  d     date := p_date;
  n     int := 0;
begin
  if start is null then return 0; end if;
  while d >= start and d > p_date - 400 loop
    if day_status_of(p_athlete, d) = 'training' then
      if exists (select 1 from set_logs where athlete_id = p_athlete and date = d and claimed is not null) then
        n := n + 1;
      elsif d < app_today() then
        exit;
      end if;
    end if;
    d := d - 1;
  end loop;
  return n;
end $$;

-- Множитель серии: 1, пока серия меньше streak_from, потом растёт на шаг в день до потолка.
create function public.streak_mult(r public.rules, p_streak int) returns numeric
language sql immutable as $$
  select case
    when r.streak_from is null or r.streak_step is null or p_streak < r.streak_from then 1
    else least(coalesce(r.streak_max, 1000), 1 + r.streak_step * (p_streak - r.streak_from + 1)) end
$$;

-- Понедельник недели этого дня.
create function public.week_start(p_date date) returns date
language sql immutable as $$ select p_date - (extract(isodow from p_date)::int - 1) $$;

create function public.lock_athlete(p_athlete uuid) returns void
language sql as $$ select pg_advisory_xact_lock(hashtext('athlete:' || p_athlete)) $$;

-- ───────────── Очки за подход ─────────────

-- Пересчитать очки подхода и записать разницу в журнал. Вызывается при проверке
-- и когда атлет меняет число после проверки. Баланс ниже нуля не уходит.
create function public.award_set(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  l      set_logs;
  r      rules;
  ex     jsonb;
  target int;
  nm     text;
  base   numeric;
  mult   numeric := 1;
  pts    int := 0;
  bon    int := 0;
  other  int;
  had    int;
  delta  int;
  bal    int;
  note   text;
  ok     boolean;
begin
  select * into l from set_logs where id = p_id;
  if not found then return; end if;
  perform lock_athlete(l.athlete_id);
  select * into l from set_logs where id = p_id for update;
  r := rules_for(l.date);
  ok := l.review in ('accepted', 'corrected') and l.confirmed is not null and not coalesce(r.calibration, true);

  select value into ex from days d, jsonb_array_elements(coalesce(d.plan, '[]'::jsonb))
  where d.athlete_id = l.athlete_id and d.date = l.date and (value ->> 'id')::bigint = l.exercise_id;
  target := (ex ->> 'target_reps')::int;
  nm := coalesce(ex ->> 'name', (select name from exercises where id = l.exercise_id), 'Подход');

  if ok then
    base := l.confirmed * coalesce(r.points_per_rep, 0)
          + case when l.confirmed > 0 and (target is null or l.confirmed >= target)
                 then coalesce(r.points_per_set, 0) else 0 end;
    mult := streak_mult(r, streak_at(l.athlete_id, l.date));
    pts := round(base * mult);
    if target is not null and l.confirmed > target and coalesce(r.bonus_over, 0) > 0 then
      bon := round((l.confirmed - target) * r.bonus_over);
      if r.bonus_cap_day is not null then
        select coalesce(sum(bonus), 0) into other from set_logs
        where athlete_id = l.athlete_id and date = l.date and id <> l.id;
        bon := greatest(0, least(bon, r.bonus_cap_day - other));
      end if;
    end if;
  end if;

  had := coalesce(l.points, 0) + coalesce(l.bonus, 0);
  update set_logs set
    points = case when ok then pts end,
    bonus  = case when ok then bon end
  where id = l.id;

  delta := pts + bon - had;
  if delta = 0 then return; end if;

  note := nm || ' · подход ' || l.set_no;
  if l.points is not null or l.bonus is not null then note := 'Пересмотр: ' || note; end if;
  if ok and mult > 1 then note := note || ' · серия ×' || trim_scale(round(mult, 2))::text; end if;
  if ok and bon > 0 then note := note || ' · сверх цели +' || bon; end if;

  bal := balance_of(l.athlete_id);
  insert into ledger (athlete_id, date, kind, amount, rating, note, set_id)
  values (l.athlete_id, l.date, 'set', greatest(delta, -bal), delta, note, l.id);
end $$;

-- Разовые начисления: штраф за пропуск, бонус за рост, вехи цели.
-- Вызывается после проверки и раз в час из бота; каждая запись — один раз (key).
create function public.settle(p_athlete uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  today date := app_today();
  start date := (select start_date from settings where id = 1);
  d     date;
  wk    date;
  r     rules;
  bal   int;
  pen   int;
  cnt   int;
  price int;
  pct   int;
begin
  if start is null then return; end if;
  perform lock_athlete(p_athlete);

  -- Пропуск: закрытый тренировочный день без единой отметки.
  d := greatest(start, today - 30);
  while d < today loop
    r := rules_for(d);
    if not coalesce(r.calibration, true) and coalesce(r.miss_penalty, 0) > 0
       and day_status_of(p_athlete, d) = 'training'
       and not exists (select 1 from set_logs where athlete_id = p_athlete and date = d and claimed is not null)
       and not exists (select 1 from ledger where athlete_id = p_athlete and key = 'penalty:' || d) then
      perform ensure_day(p_athlete, d);
      bal := balance_of(p_athlete);
      pen := least(r.miss_penalty, bal);
      insert into ledger (athlete_id, date, kind, amount, rating, note, key)
      values (p_athlete, d, 'penalty', -pen, 0,
              'Пропуск тренировки' || case when pen < r.miss_penalty then ' · баланс не уходит ниже нуля' else '' end,
              'penalty:' || d);
    end if;
    d := d + 1;
  end loop;

  -- Рост: за каждое упражнение, где лучший подход недели больше, чем на прошлой неделе.
  -- Считается, когда неделя закончилась и обе недели проверены.
  for i in 1..5 loop
    wk := week_start(today) - 7 * i;
    continue when wk + 6 < start;
    r := rules_for(wk + 6);
    continue when coalesce(r.calibration, true) or coalesce(r.bonus_growth, 0) = 0;
    continue when exists (select 1 from ledger where athlete_id = p_athlete and key = 'growth:' || wk);
    continue when exists (select 1 from set_logs where athlete_id = p_athlete and date between wk - 7 and wk + 6
                          and review = 'pending' and claimed is not null);
    select count(*) into cnt
    from (select exercise_id, max(confirmed) best from set_logs
          where athlete_id = p_athlete and date between wk and wk + 6 and review in ('accepted', 'corrected')
          group by exercise_id) cur
    join (select exercise_id, max(confirmed) best from set_logs
          where athlete_id = p_athlete and date between wk - 7 and wk - 1 and review in ('accepted', 'corrected')
          group by exercise_id) prev using (exercise_id)
    where cur.best > prev.best;
    if cnt > 0 then
      insert into ledger (athlete_id, date, kind, amount, rating, note, key)
      values (p_athlete, wk + 6, 'bonus_growth', cnt * r.bonus_growth, cnt * r.bonus_growth,
              'Рост за неделю: лучший подход вырос в ' || cnt || ' упр.', 'growth:' || wk);
    end if;
  end loop;

  -- Вехи пути к телефону: по балансу, каждая один раз.
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

-- ───────────── Изменения функций v1 ─────────────

-- Как в v1, плюс: если число поменяли после проверки, очки за подход снимаются.
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
    if prev.claimed is distinct from p_claimed and (prev.points is not null or prev.bonus is not null) then
      perform award_set(res.id);
      select * into res from set_logs where id = res.id;
    end if;
  end if;
  return res;
end $$;

-- Как в v1, плюс очки: считаются здесь, в момент решения.
create or replace function public.review_set(
  p_id bigint, p_decision public.review_status, p_confirmed int, p_comment text
) returns public.set_logs
language plpgsql security definer set search_path = public as $$
declare
  prev public.set_logs;
  res public.set_logs;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  select * into prev from set_logs where id = p_id for update;
  if not found then raise exception 'Подход не найден'; end if;
  if p_decision = 'corrected' and p_confirmed is null then
    raise exception 'Укажи подтверждённое число';
  end if;
  update set_logs set
    review      = p_decision,
    confirmed   = case p_decision
                    when 'accepted'  then prev.claimed
                    when 'corrected' then p_confirmed
                    when 'rejected'  then 0
                    else null end,
    comment     = nullif(trim(p_comment), ''),
    reviewed_at = case when p_decision = 'pending' then null else now() end,
    updated_at  = now()
  where id = p_id;
  perform award_set(p_id);
  perform settle(prev.athlete_id);
  select * into res from set_logs where id = p_id;
  return res;
end $$;

-- Как в v1, плюс: купленный выходной ставит только покупка; если Тимур меняет
-- купленный день — очки возвращаются; если пропуск стал больничным или выходным — штраф возвращается.
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
    update days set plan = current_plan() where athlete_id = p_athlete and date = p_date
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

-- ───────────── Функции v3 ─────────────

-- Правила сейчас и с завтра — для экранов.
create function public.rules_now() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'current', to_json(rules_for(app_today())),
    'next',    to_json(rules_for(app_today() + 1)),
    'from',    app_today() + 1)
$$;

-- Сохранить правила: действуют со следующего дня. Повторное сохранение в тот же день
-- просто перезаписывает завтрашние правила.
create function public.save_rules(p jsonb) returns public.rules
language plpgsql security definer set search_path = public as $$
declare
  r public.rules;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  r := jsonb_populate_record(null::public.rules, p);
  r.valid_from := app_today() + 1;
  r.calibration := coalesce(r.calibration, true);
  r.saved_at := now();
  insert into rules values (r.*)
  on conflict (valid_from) do update set
    calibration = excluded.calibration, points_per_rep = excluded.points_per_rep,
    points_per_set = excluded.points_per_set, streak_from = excluded.streak_from,
    streak_step = excluded.streak_step, streak_max = excluded.streak_max,
    bonus_growth = excluded.bonus_growth, bonus_over = excluded.bonus_over,
    bonus_cap_day = excluded.bonus_cap_day, miss_penalty = excluded.miss_penalty,
    rest_day_price = excluded.rest_day_price, purchase_limit_week = excluded.purchase_limit_week,
    phone_price = excluded.phone_price, saved_at = excluded.saved_at
  returning * into r;
  return r;
end $$;

-- Счёт атлета: баланс, рейтинг, серия, цена телефона.
create function public.wallet(p_athlete uuid default null) returns json
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
    'mult', streak_mult(r, s), 'phone_price', r.phone_price);
end $$;

-- Купить выходной: только на будущий тренировочный день, за баланс.
create function public.buy_rest_day(p_date date) returns public.purchases
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
  if r.purchase_limit_week is not null then
    select count(*) into cnt from purchases
    where athlete_id = uid and status = 'active'
      and week_start(date) = week_start(p_date);
    if cnt >= r.purchase_limit_week then
      raise exception 'На этой неделе лимит: % вых.', r.purchase_limit_week;
    end if;
  end if;
  bal := balance_of(uid);
  if bal < r.rest_day_price then
    raise exception 'Не хватает очков: нужно %, на балансе %', r.rest_day_price, bal;
  end if;

  insert into purchases (athlete_id, date, price, prev_status)
  values (uid, p_date, r.rest_day_price, st) returning * into res;
  insert into days (athlete_id, date, status) values (uid, p_date, 'bought')
  on conflict (athlete_id, date) do update set status = 'bought', updated_at = now();
  insert into ledger (athlete_id, date, kind, amount, note)
  values (uid, p_date, 'purchase', -res.price, 'Выходной на ' || bot_day_title(p_date));
  return res;
end $$;

-- Отменить покупку: только до начала того дня. Очки возвращаются.
create function public.cancel_purchase(p_id bigint) returns public.purchases
language plpgsql security definer set search_path = public as $$
declare
  p   public.purchases;
  res public.purchases;
begin
  if auth.uid() is null then raise exception 'Нужно войти'; end if;
  select * into p from purchases where id = p_id;
  if not found or (p.athlete_id <> auth.uid() and not is_admin()) then raise exception 'Покупка не найдена'; end if;
  perform lock_athlete(p.athlete_id);
  select * into p from purchases where id = p_id for update;
  if p.status = 'cancelled' then raise exception 'Покупка уже отменена'; end if;
  if p.date <= app_today() then raise exception 'Отменить можно только до начала дня'; end if;

  update purchases set status = 'cancelled', cancelled_at = now() where id = p_id returning * into res;
  update days set status = p.prev_status, updated_at = now()
  where athlete_id = p.athlete_id and date = p.date and status = 'bought';
  insert into ledger (athlete_id, date, kind, amount, note)
  values (p.athlete_id, p.date, 'refund', p.price, 'Отмена выходного на ' || bot_day_title(p.date));
  return res;
end $$;

-- Попросить больничный на сегодня. Решает Тимур.
create function public.request_sick(p_note text) returns public.sick_requests
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  res public.sick_requests;
begin
  if uid is null then raise exception 'Нужно войти'; end if;
  if day_status_of(uid, app_today()) is distinct from 'training' then
    raise exception 'Сегодня и так нет тренировки';
  end if;
  insert into sick_requests (athlete_id, date, note) values (uid, app_today(), nullif(trim(p_note), ''))
  on conflict (athlete_id, date) do update set
    status = 'pending', note = excluded.note, created_at = now(), decided_at = null
  where sick_requests.status = 'declined'
  returning * into res;
  if res.id is null then raise exception 'Запрос на сегодня уже отправлен'; end if;
  return res;
end $$;

-- Решение Тимура по больничному. Одобрение ставит день «больничный» (и снимает штраф, если был).
create function public.decide_sick(p_id bigint, p_approve boolean) returns public.sick_requests
language plpgsql security definer set search_path = public as $$
declare
  res public.sick_requests;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  update sick_requests set status = case when p_approve then 'approved' else 'declined' end::request_status,
    decided_at = now()
  where id = p_id returning * into res;
  if not found then raise exception 'Запрос не найден'; end if;
  if p_approve then perform set_day_status(res.athlete_id, res.date, 'sick'); end if;
  return res;
end $$;

create function public.add_idea(p_text text) returns public.ideas
language plpgsql security definer set search_path = public as $$
declare
  res public.ideas;
begin
  if auth.uid() is null then raise exception 'Нужно войти'; end if;
  if length(trim(coalesce(p_text, ''))) = 0 then raise exception 'Напиши идею'; end if;
  if (select count(*) from ideas where athlete_id = auth.uid() and created_at > now() - interval '1 day') >= 10 then
    raise exception 'Не больше 10 идей в день';
  end if;
  insert into ideas (athlete_id, text) values (auth.uid(), trim(p_text)) returning * into res;
  return res;
end $$;

create function public.set_idea_status(p_id bigint, p_status public.idea_status) returns public.ideas
language plpgsql security definer set search_path = public as $$
declare
  res public.ideas;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  update ideas set status = p_status, decided_at = case when p_status = 'new' then null else now() end
  where id = p_id returning * into res;
  if not found then raise exception 'Идея не найдена'; end if;
  return res;
end $$;

-- ───────────── Бот: новые события ─────────────
-- Как в v2, плюс: раз в час подводит разовые начисления (штрафы, рост, вехи),
-- в итог дня добавляет штраф, а в «Итоги» пишет о вехах, покупках, больничном и идеях.

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
  planned int;
  done    int;
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

    -- Вечернее напоминание: в час напоминания, если тренировка заполнена не вся.
    if extract(hour from now_l) >= cfg.remind_hour
       and (st.start_date is null or today >= st.start_date)
       and not exists (select 1 from bot_log l where l.key = 'remind:' || a.id || ':' || today) then
      d := ensure_day(a.id, today);
      if d.status = 'training' then
        select coalesce(sum((value ->> 'sets')::int), 0) into planned from jsonb_array_elements(coalesce(d.plan, '[]'::jsonb));
        select count(*) into done from set_logs s
        where s.athlete_id = a.id and s.date = today and s.claimed is not null;
        if done < planned then
          key := 'remind:' || a.id || ':' || today; chat_id := cfg.chat_id; topic := cfg.results_topic;
          msg := coalesce('@' || nullif(a.tg_username, ''), nullif(a.name, ''), 'Атлет') || ', сегодня тренировка: отмечено '
                  || done || ' из ' || planned || ' подходов. День закроется в 00:00.';
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
      select 'idea:' || i.id, who || ' предлагает для магазина: «' || i.text || '»'
        from ideas i where i.athlete_id = a.id and i.created_at > now() - interval '2 days'
    loop
      continue when exists (select 1 from bot_log l where l.key = e.k);
      key := e.k; chat_id := cfg.chat_id; topic := cfg.results_topic; msg := e.m;
      return next;
    end loop;
  end loop;
end $$;

-- ───────────── Права (RLS) ─────────────

alter table public.rules         enable row level security;
alter table public.ledger        enable row level security;
alter table public.purchases     enable row level security;
alter table public.sick_requests enable row level security;
alter table public.ideas         enable row level security;

-- Читать можно, писать — только через функции выше.
create policy "читают все вошедшие" on public.rules
  for select to authenticated using (true);
create policy "свои или админ" on public.ledger
  for select to authenticated using (athlete_id = auth.uid() or public.is_admin());
create policy "свои или админ" on public.purchases
  for select to authenticated using (athlete_id = auth.uid() or public.is_admin());
create policy "свои или админ" on public.sick_requests
  for select to authenticated using (athlete_id = auth.uid() or public.is_admin());
create policy "свои или админ" on public.ideas
  for select to authenticated using (athlete_id = auth.uid() or public.is_admin());

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
  public.add_idea(text), public.set_idea_status(bigint, public.idea_status)
to authenticated;
grant execute on function public.bot_outbox(), public.bot_mark_sent(text) to service_role;
