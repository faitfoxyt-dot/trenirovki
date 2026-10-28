-- Трекер тренировок · 0027: «Русская рулетка» — колесо дня.
-- Каждый тренировочный день друг сам крутит колесо на «Сегодня» (spin_roulette): один раз, бесплатно.
-- Выпавшее число прибавляется к множителю очков за подходы — к серии или, в день «Всё или ничего», к его множителю.
-- Минус не опускает множитель дня ниже settings.roulette.floor (×0.1). Событие дня и пари колесо не трогает.
-- Особые сектора: 🔫 Револьвер — друг жмёт на курок (пусто: gun.win, патрон: gun.lose) или убирает его (0), pull_trigger;
-- 🔄 Ещё раз — колесо крутится снова; ⭐ Звезда — событие дня на сегодня, если его ещё нет.
-- Не хочет рисковать (например, в день «Всё или ничего») — жмёт «Не крутить сегодня» (skip_roulette):
-- множитель как обычно, крутить в этот день уже нельзя.
-- Когда день закончился и всё проверено, settle() пишет прибавку одной записью ledger 'roulette' (roulette_apply)
-- и поправляет её, если генерал передумал. В тестовый период очков нет.
-- Шансы и числа — settings.roulette, их меняет админ в «Правилах» (save_roulette).
-- Подходы до прокрутки или отказа закрыты только на сайте (settings.roulette.lock), log_set не меняется.
-- Повторный запуск безопасен.

alter type public.ledger_kind add value if not exists 'roulette';

create table if not exists public.roulette_spins (
  athlete_id uuid not null references public.profiles (id),
  date       date not null,
  chain      text[] not null,     -- что выпадало по порядку: {double} или {respin,double}
  key        text not null,       -- итог — последний сектор; skip — друг отказался крутить
  plus       numeric,             -- прибавка к множителю; null — револьвер ещё не решён
  gun        text check (gun in ('offer', 'pass', 'click', 'bang')), -- револьвер: ждёт, убран, пусто, выстрел
  spun_at    timestamptz not null default now(),
  decided_at timestamptz,
  primary key (athlete_id, date)
);

alter table public.roulette_spins enable row level security;
-- Читает сам атлет и админ; пишут только функции ниже.
do $$ begin
  create policy "свои или админ" on public.roulette_spins
    for select to authenticated using (athlete_id = auth.uid() or public.is_admin());
exception when duplicate_object then null; end $$;

-- Настройки колеса, как DEFAULT_ROULETTE в js/roulette-data.js. В среднем около +0.1 к множителю.
-- «Холостой» (0) выключен: вместо него можно не крутить колесо. Вернуть его можно в «Правилах».
alter table public.settings add column if not exists roulette jsonb;
update public.settings set roulette = '{
  "on": true, "lock": true, "floor": 0.1,
  "items": {
    "jackpot": {"add": 1, "chance": 10}, "volley": {"add": 0.5, "chance": 8}, "double": {"add": 0.3, "chance": 12},
    "hit": {"add": 0.1, "chance": 22}, "blank": {"add": 0, "chance": 0}, "miss": {"add": -0.1, "chance": 18},
    "misfire": {"add": -0.3, "chance": 10}, "wound": {"add": -0.5, "chance": 6}, "bullet": {"add": -0.7, "chance": 4},
    "revolver": {"chance": 4}, "respin": {"chance": 4}, "star": {"chance": 2}
  },
  "gun": {"win": 0.5, "lose": -1, "chambers": 6}
}'::jsonb
where id = 1 and roulette is null;

-- ───────────── Функции ─────────────

-- Сектора в порядке колеса, как OUTCOMES в js/roulette-data.js.
create or replace function public.roulette_keys() returns text[]
language sql immutable as $$
  select array['jackpot', 'miss', 'double', 'respin', 'misfire', 'hit', 'wound', 'volley', 'revolver', 'blank', 'star', 'bullet']
$$;

create or replace function public.roulette_cfg() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select roulette from settings where id = 1), '{}'::jsonb)
$$;

-- «💰 Джекпот», «🔫 Револьвер: щёлк, пусто», «🚫 Без колеса».
create or replace function public.roulette_name(p_key text, p_gun text default null) returns text
language sql immutable as $$
  select case p_key
      when 'jackpot' then '💰 Джекпот' when 'miss' then '🙈 Мимо' when 'double' then '💥 Дуплет'
      when 'respin' then '🔄 Ещё раз' when 'misfire' then '😬 Осечка' when 'hit' then '🎯 Попадание'
      when 'wound' then '🩹 Ранение' when 'volley' then '🎆 Залп' when 'revolver' then '🔫 Револьвер'
      when 'star' then '⭐ Звезда' when 'bullet' then '💀 Пуля' when 'skip' then '🚫 Без колеса' else '💨 Холостой' end
    || case p_gun when 'click' then ': щёлк, пусто' when 'bang' then ': выстрел' when 'pass' then ' убран'
                  when 'offer' then ' не решён' else '' end
$$;

-- «+0.3», «−0.7», «0» — как addText.
create or replace function public.roulette_add_text(v numeric) returns text
language sql immutable as $$
  select case when round(coalesce(v, 0), 2) > 0 then '+' || trim_scale(round(v, 2))::text
              when round(coalesce(v, 0), 2) < 0 then '−' || trim_scale(-round(v, 2))::text
              else '0' end
$$;

-- Число из настроек в пределах (для save_roulette); int — ещё и целое.
create or replace function public.roulette_num(v jsonb, lo numeric, hi numeric, p_int boolean default false) returns boolean
language sql immutable as $$
  select case when jsonb_typeof(v) = 'number'
              then (v #>> '{}')::numeric between lo and hi
                   and (not p_int or (v #>> '{}')::numeric = trunc((v #>> '{}')::numeric))
              else false end
$$;

-- Случайный сектор по шансам. p_exclude — каких сегодня быть не может.
create or replace function public.roulette_pick(p_cfg jsonb, p_exclude text[] default '{}') returns text
language plpgsql volatile set search_path = public as $$
declare
  k     text;
  w     numeric;
  total numeric := 0;
  x     numeric;
  fallback text;
begin
  foreach k in array roulette_keys() loop
    continue when k = any (p_exclude);
    w := coalesce((p_cfg -> 'items' -> k ->> 'chance')::numeric, 0);
    if w > 0 then total := total + w; end if;
  end loop;
  if total <= 0 then return 'blank'; end if;
  x := random() * total;
  foreach k in array roulette_keys() loop
    continue when k = any (p_exclude);
    w := coalesce((p_cfg -> 'items' -> k ->> 'chance')::numeric, 0);
    continue when w <= 0;
    fallback := k;
    x := x - w;
    if x < 0 then return k; end if;
  end loop;
  return coalesce(fallback, 'blank');
end $$;

-- Колесо за день, как rouletteState в js/api/demo.js. null — в этот день колеса нет.
-- m — множитель до колеса (серия или «Всё или ничего»), mult — после, bonus — сколько колесо даёт сверху.
-- need — сегодня друг ещё должен крутить колесо (или отказаться от него) или решить с револьвером.
create or replace function public.roulette_state(p_athlete uuid, p_date date) returns json
language plpgsql stable security definer set search_path = public as $$
declare
  sp      roulette_spins;
  has     boolean;
  cfg     jsonb := roulette_cfg();
  today   date := app_today();
  start   date := (select start_date from settings where id = 1);
  live    boolean;
  test    boolean := is_test_day(p_date);
  r       rules := rules_for(case when is_test_day(p_date) then app_today() else p_date end);
  al      json;
  pts     int;
  base    numeric;
  k       numeric;
  m       numeric;
  plus    numeric;
  mult    numeric;
  lo      numeric := case when jsonb_typeof(cfg -> 'floor') = 'number' then (cfg ->> 'floor')::numeric end;
  pending boolean;
begin
  select * into sp from roulette_spins where athlete_id = p_athlete and date = p_date;
  has := found;
  live := coalesce(coalesce((cfg ->> 'on')::boolean, false) and p_date = today
                   and day_status_of(p_athlete, p_date) = 'training' and (start is null or p_date >= start), false);
  if not has and not live then return null; end if;

  if test then
    select coalesce(sum(t.points), 0), sum(t.points / coalesce(nullif(t.mult, 0), 1)), max(t.mult) into pts, base, k
    from theory_points t where t.athlete_id = p_athlete and t.date = p_date;
  else
    select coalesce(sum(s.points), 0), sum(s.points / coalesce(nullif(s.mult, 0), 1)), max(s.mult) into pts, base, k
    from set_logs s where s.athlete_id = p_athlete and s.date = p_date and s.points is not null;
  end if;
  base := coalesce(base, 0);
  k := coalesce(k, trim_scale(round(streak_mult(r, day_streak(p_athlete, p_date)), 2)), 1);
  al := allin_state(p_athlete, p_date);
  m := coalesce((al ->> 'mult')::numeric, k);
  plus := coalesce(sp.plus, 0);
  mult := round(m + plus, 2);
  -- Минус не опускает ниже пола, но и не поднимает до пола день, где «Всё или ничего» уже ниже.
  if lo is not null then mult := greatest(least(m, lo), mult); end if;
  pending := exists (select 1 from set_logs s where s.athlete_id = p_athlete and s.date = p_date
                     and s.review = 'pending' and s.claimed is not null);

  return json_build_object(
    'date', p_date,
    'need', live and (not has or sp.gun is not distinct from 'offer'),
    'spin', case when has then json_build_object('chain', sp.chain, 'key', sp.key, 'add', trim_scale(sp.plus),
                                                 'gun', sp.gun, 'spun_at', sp.spun_at, 'decided_at', sp.decided_at) end,
    'k', trim_scale(k), 'allin', (al ->> 'mult')::numeric, 'm', trim_scale(m), 'mult', trim_scale(mult),
    'floored', lo is not null and round(m + plus, 2) < least(m, lo),
    'base', round(base)::int, 'points', pts, 'bonus', round(base * (mult - m))::int,
    'final', p_date < today and not pending and (al is null or (al ->> 'final')::boolean),
    'test', test,
    'applied', (select coalesce(sum(l.rating), 0) from ledger l
                where l.athlete_id = p_athlete and l.date = p_date and l.kind = 'roulette'));
end $$;

-- Записать разницу между тем, что колесо должно дать, и тем, что уже в журнале. Зовёт settle().
create or replace function public.roulette_apply(p_athlete uuid, p_date date) returns void
language plpgsql security definer set search_path = public as $$
declare
  s     json := roulette_state(p_athlete, p_date);
  want  int := 0;
  have  int;
  delta int;
begin
  if s is null or s ->> 'spin' is null or (s ->> 'test')::boolean then return; end if;
  if (s ->> 'final')::boolean and day_status_of(p_athlete, p_date) = 'training' then want := (s ->> 'bonus')::int; end if;
  have := (s ->> 'applied')::int;
  delta := want - have;
  if delta = 0 then return; end if;
  insert into ledger (athlete_id, date, kind, amount, rating, note)
  values (p_athlete, p_date, 'roulette', greatest(delta, -balance_of(p_athlete)), delta,
          case when want = 0 then '🎰 Рулетка: день не засчитан'
               else case when have <> 0 then 'Пересмотр: ' else '' end
                    || '🎰 Рулетка: ' || roulette_name(s -> 'spin' ->> 'key', s -> 'spin' ->> 'gun') || ' '
                    || roulette_add_text((s -> 'spin' ->> 'add')::numeric)
                    || ' · очки за подходы ×' || (s ->> 'mult') end);
end $$;

-- Колесо за день для экрана (своё или, админу, любого). В тестовый период друг очков не видит.
create or replace function public.roulette_day(p_date date, p_athlete uuid default null) returns json
language plpgsql stable security definer set search_path = public as $$
declare
  who uuid := coalesce(p_athlete, auth.uid());
  s   jsonb;
begin
  if auth.uid() is null then raise exception 'Нужно войти'; end if;
  if who <> auth.uid() and not is_admin() then raise exception 'Нет доступа'; end if;
  s := roulette_state(who, p_date)::jsonb;
  if s is null then return null; end if;
  if (s ->> 'test')::boolean and not is_admin() then
    s := s || jsonb_build_object('points', null, 'bonus', null);
  end if;
  return s::json;
end $$;

-- Крутить колесо: сектор выбирает база по шансам. «Ещё раз» — второй сектор (уже без «ещё раз»),
-- звезды нет, если событие на сегодня уже есть, револьвер ждёт решения (pull_trigger).
create or replace function public.spin_roulette() returns json
language plpgsql security definer set search_path = public as $$
declare
  uid   uuid := auth.uid();
  today date := app_today();
  cfg   jsonb := roulette_cfg();
  s     json;
  banned text[] := '{}';
  picks  text[];
  k     text;
begin
  if uid is null then raise exception 'Нужно войти'; end if;
  if (select role from profiles where id = uid) is distinct from 'athlete' then raise exception 'Колесо крутит атлет'; end if;
  perform lock_athlete(uid);
  select key into k from roulette_spins where athlete_id = uid and date = today;
  if found then
    raise exception '%', case when k = 'skip' then 'Сегодня колесо уже пропущено' else 'Колесо сегодня уже крутили' end;
  end if;
  s := roulette_state(uid, today);
  if s is null or not (s ->> 'need')::boolean then raise exception 'Сегодня колеса нет'; end if;
  if exists (select 1 from day_events where athlete_id = uid and date = today and active) then banned := array['star']; end if;

  picks := array[roulette_pick(cfg, banned)];
  if picks[1] = 'respin' then picks := picks || roulette_pick(cfg, banned || 'respin'::text); end if;
  k := picks[cardinality(picks)];
  insert into roulette_spins (athlete_id, date, chain, key, plus, gun)
  values (uid, today, picks, k,
          case when k = 'revolver' then null when k in ('respin', 'star') then 0
               else coalesce((cfg -> 'items' -> k ->> 'add')::numeric, 0) end,
          case when k = 'revolver' then 'offer' end);
  if k = 'star' then
    insert into day_events (athlete_id, date, game, title)
    values (uid, today, 'a', 'Звезда с колеса')
    on conflict (athlete_id, date) do update
    set game = excluded.game, title = excluded.title, active = true, score = null, done = false, played_at = null;
  end if;
  return roulette_day(today);
end $$;

-- «Не крутить сегодня»: множитель как обычно. Отказ — до конца дня, крутить потом уже нельзя.
create or replace function public.skip_roulette() returns json
language plpgsql security definer set search_path = public as $$
declare
  uid   uuid := auth.uid();
  today date := app_today();
  s     json;
  k     text;
begin
  if uid is null then raise exception 'Нужно войти'; end if;
  if (select role from profiles where id = uid) is distinct from 'athlete' then raise exception 'Колесо крутит атлет'; end if;
  perform lock_athlete(uid);
  select key into k from roulette_spins where athlete_id = uid and date = today;
  if found then
    raise exception '%', case when k = 'skip' then 'Сегодня колесо уже пропущено' else 'Колесо сегодня уже крутили' end;
  end if;
  s := roulette_state(uid, today);
  if s is null or not (s ->> 'need')::boolean then raise exception 'Сегодня колеса нет'; end if;
  insert into roulette_spins (athlete_id, date, chain, key, plus) values (uid, today, '{}', 'skip', 0);
  return roulette_day(today);
end $$;

-- Револьвер: жать на курок (1 патрон из chambers) или убрать — тогда 0. Решение одно.
create or replace function public.pull_trigger(p_pull boolean) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid   uuid := auth.uid();
  today date := app_today();
  g     jsonb := coalesce(roulette_cfg() -> 'gun', '{}'::jsonb);
  pull  boolean := coalesce(p_pull, false);
  bang  boolean;
begin
  if uid is null then raise exception 'Нужно войти'; end if;
  perform lock_athlete(uid);
  if not exists (select 1 from roulette_spins where athlete_id = uid and date = today and gun = 'offer') then
    raise exception 'Револьвера сегодня нет';
  end if;
  bang := pull and random() * greatest(coalesce((g ->> 'chambers')::int, 6), 2) < 1;
  update roulette_spins set
    gun = case when not pull then 'pass' when bang then 'bang' else 'click' end,
    plus = case when not pull then 0
               when bang then coalesce((g ->> 'lose')::numeric, -1)
               else coalesce((g ->> 'win')::numeric, 0.5) end,
    decided_at = now()
  where athlete_id = uid and date = today;
  return roulette_day(today);
end $$;

-- Сохранить настройки колеса (админ, «Правила»). Проверка — как rouletteProblems в js/roulette-data.js.
create or replace function public.save_roulette(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare
  k     text;
  it    jsonb;
  items jsonb := '{}'::jsonb;
  total int := 0;
  g     jsonb := coalesce(p -> 'gun', '{}'::jsonb);
  lo    jsonb := p -> 'floor';
  cfg   jsonb;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  foreach k in array roulette_keys() loop
    it := coalesce(p -> 'items' -> k, '{}'::jsonb);
    if not roulette_num(it -> 'chance', 0, 100, true) then
      raise exception 'Рулетка: % — шанс целое от 0 до 100', roulette_name(k);
    end if;
    total := total + (it ->> 'chance')::int;
    if k in ('revolver', 'respin', 'star') then
      items := items || jsonb_build_object(k, jsonb_build_object('chance', (it ->> 'chance')::int));
    else
      if not roulette_num(it -> 'add', -2, 2) then
        raise exception 'Рулетка: % — прибавка от −2 до 2', roulette_name(k);
      end if;
      items := items || jsonb_build_object(k, jsonb_build_object(
        'add', trim_scale(round((it ->> 'add')::numeric, 2)), 'chance', (it ->> 'chance')::int));
    end if;
  end loop;
  if total <> 100 then raise exception 'Рулетка: сумма шансов %, а нужно 100%%', total || '%'; end if;
  if not roulette_num(g -> 'chambers', 2, 12, true) then raise exception 'Рулетка: револьвер — гнёзд от 2 до 12'; end if;
  if not (roulette_num(g -> 'win', -2, 2) and roulette_num(g -> 'lose', -2, 2)) then
    raise exception 'Рулетка: револьвер — прибавки от −2 до 2';
  end if;
  if lo is not null and jsonb_typeof(lo) <> 'null' and not roulette_num(lo, 0, 1) then
    raise exception 'Рулетка: множитель дня не ниже — от 0 до 1';
  end if;

  cfg := jsonb_build_object(
    'on', coalesce(p -> 'on' = 'true'::jsonb, false),
    'lock', not coalesce(p -> 'lock' = 'false'::jsonb, false),
    'floor', case when lo is null or jsonb_typeof(lo) = 'null' then null else trim_scale(round((lo #>> '{}')::numeric, 2)) end,
    'items', items,
    'gun', jsonb_build_object('win', trim_scale(round((g ->> 'win')::numeric, 2)),
                              'lose', trim_scale(round((g ->> 'lose')::numeric, 2)),
                              'chambers', (g ->> 'chambers')::int));
  update settings set roulette = cfg, updated_at = now() where id = 1;
  return cfg::json;
end $$;

-- settle: как в 0024, плюс колесо — после «Всё или ничего».
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

  -- Колесо дня: прибавка к множителю очков за подходы, когда день закончился и всё проверено (и пересмотр).
  for ad in select s.date from roulette_spins s
            where s.athlete_id = p_athlete and s.date < today and s.date >= today - 60 loop
    perform roulette_apply(p_athlete, ad);
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

-- Итог дня для бота: как в 0013, плюс строка «Колесо» в тренировочный день (что выпало или «не крутил»).
create or replace function public.bot_summary_text(p_athlete uuid, p_date date) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  p     profiles;
  d     days;
  m     morning_checks;
  b     body_checks;
  pb    body_checks;
  sp    roulette_spins;
  ex    jsonb;
  reps  text;
  vids  int;
  c     int[];
  lines text[] := '{}';
  sec   boolean;
begin
  select * into p from profiles where id = p_athlete;
  select * into d from days where athlete_id = p_athlete and date = p_date;
  select * into m from morning_checks where athlete_id = p_athlete and date = p_date;
  select * into b from body_checks where athlete_id = p_athlete and date = p_date;
  select * into pb from body_checks where athlete_id = p_athlete and date < p_date order by date desc limit 1;

  lines := lines || ('Итог · ' || bot_day_title(p_date) || ' · ' || coalesce(nullif(p.name, ''), 'атлет'));

  if d.status is distinct from 'training' then
    lines := lines || case d.status
      when 'rest'   then 'Выходной'
      when 'bought' then 'Купленный выходной'
      when 'sick'   then 'Больничный'
      when 'busy'   then 'Занят, без задания'
      else 'План на день не был задан' end;
  else
    c := day_counts(p_athlete, p_date);
    if c[1] = 0 then
      lines := lines || 'Пропуск: ни одного подхода'::text;
    else
      for ex in select value from jsonb_array_elements(coalesce(d.plan, '[]'::jsonb)) loop
        sec := coalesce((select unit from exercises where id = (ex ->> 'id')::bigint), ex ->> 'unit') = 'sec';
        select string_agg(coalesce(l.claimed::text || case when sec then ' с' else '' end, '—'), ' · ' order by g),
               count(*) filter (where l.has_video)
          into reps, vids
        from generate_series(1, (ex ->> 'sets')::int) g
        left join set_logs l on l.athlete_id = p_athlete and l.date = p_date
                            and l.exercise_id = (ex ->> 'id')::bigint and l.set_no = g;
        lines := lines || ((ex ->> 'name') || ': ' || reps || ' (видео ' || vids || '/' || (ex ->> 'sets') || ')');
      end loop;
      if c[1] < c[2] then
        lines := lines || ('Пропуск: сделано ' || c[1] || ' из ' || c[2] || ' подходов');
      end if;
    end if;
    select * into sp from roulette_spins where athlete_id = p_athlete and date = p_date;
    if found then
      lines := lines || ('Колесо: ' || case when cardinality(sp.chain) > 1 then '🔄 → ' else '' end
        || case when sp.key = 'skip' then '🚫 не крутил' else roulette_name(sp.key, sp.gun) end
        || case when sp.key = 'star' then ' — событие дня'
                else case when sp.key = 'skip' then '' else ' ' || roulette_add_text(sp.plus) end
                     || ' · очки за подходы ×' || coalesce(roulette_state(p_athlete, p_date) ->> 'mult', '1') end);
    end if;
  end if;

  if m.muscles is not null or m.energy is not null then
    lines := lines || ('Утро: ' || coalesce(case m.muscles
        when 'ok' then 'готов' when 'sore' then 'так себе' when 'pain' then 'плохо' end, '—')
      || ', энергия ' || coalesce(m.energy::text, '—'));
  end if;

  if b.weight is not null then
    lines := lines || ('Взвешивание: ' || bot_num(b.weight) || ' кг'
      || coalesce(' (' || bot_delta(b.weight - pb.weight) || ')', '')
      || coalesce(' · жир ' || bot_num(b.fat) || '%' || coalesce(' (' || bot_delta(b.fat - pb.fat) || ')', ''), ''));
  end if;

  return array_to_string(lines, E'\n');
end $$;

-- ───────────── Права ─────────────

grant execute on function public.roulette_day(date, uuid), public.spin_roulette(), public.skip_roulette(),
  public.pull_trigger(boolean), public.save_roulette(jsonb) to authenticated;
