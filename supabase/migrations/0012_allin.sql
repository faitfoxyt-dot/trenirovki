-- Трекер тренировок · 0012: «Всё или ничего» (ALL IN) — модификатор дня в магазине.
-- Друг покупает его заранее на тренировочный день. В этот день у множителя очков есть добавка:
-- каждое упражнение плана, сделанное полностью (все подходы, каждый не меньше цели), даёт +allin_up,
-- каждое несделанное — −allin_down. Добавка складывается с множителем серии:
-- итог = max(0.1, серия + up × сделано − down × не сделано), и он действует на все очки этого дня.
-- Считается, когда день закончился и все его подходы проверены; разница с обычными очками
-- дня пишется в журнал одной записью (kind = 'modifier'). Передумал при проверке — запись поправится.
-- В тестовый период очки модификатора не начисляются, Тимур видит только расчёт.
-- Цена, добавки и лимит в неделю — в «Правилах». Начальные: 2000, +0.3, −0.7, 1 в неделю.
-- Повторный запуск безопасен.

alter type public.ledger_kind add value if not exists 'modifier';

-- Что куплено: 'rest' — выходной, 'allin' — «Всё или ничего». День с ALL IN остаётся тренировкой.
alter table public.purchases add column if not exists kind text not null default 'rest';
do $$ begin
  alter table public.purchases add constraint purchases_kind_check check (kind in ('rest', 'allin'));
exception when duplicate_object then null; end $$;

alter table public.rules
  add column if not exists allin_price int check (allin_price >= 1),
  add column if not exists allin_up numeric check (allin_up >= 0),
  add column if not exists allin_down numeric check (allin_down >= 0),
  add column if not exists allin_limit_week int check (allin_limit_week >= 0);

-- Начальные числа — в действующие правила, если Тимур их ещё не задал.
update public.rules set allin_price = 2000, allin_up = 0.3, allin_down = 0.7, allin_limit_week = 1
where valid_from = (select max(valid_from) from public.rules)
  and allin_price is null and allin_up is null and allin_down is null and allin_limit_week is null;

-- ───────────── Расчёт дня ─────────────

-- Состояние «Всё или ничего» у атлета в этот день; null — модификатор не куплен.
-- Подход упражнения: «да» — проверен и не меньше цели; «нет» — проверен и меньше цели (отклонён = 0)
-- или день закончился, а подхода нет; иначе «ждём» (ещё не сделан сегодня или не проверен).
-- Упражнение: сделано — все подходы «да»; не сделано — хоть один «нет»; иначе ждём.
-- mult — множитель по уже решённым упражнениям, best — если все ждущие будут сделаны.
-- points — очки дня с серией (в тестовый период — теория), bonus — сколько добавит или снимет модификатор.
create or replace function public.allin_state(p_athlete uuid, p_date date) returns json
language plpgsql stable security definer set search_path = public as $$
declare
  p     purchases;
  test  boolean := is_test_day(p_date);
  r     rules := rules_for(case when is_test_day(p_date) then app_today() else p_date end);
  up    numeric;
  dn    numeric;
  ended boolean := p_date < app_today();
  plan  jsonb;
  ex    jsonb;
  tgt   int;
  n     int;
  n_yes int;
  n_no  int;
  st    text;
  done  int := 0;
  miss  int := 0;
  wait  int := 0;
  items jsonb := '[]'::jsonb;
  pts   int;
  k     numeric;
  m     numeric;
  best  numeric;
  bonus int;
begin
  select * into p from purchases
  where athlete_id = p_athlete and date = p_date and status = 'active' and kind = 'allin';
  if not found then return null; end if;
  up := coalesce(r.allin_up, 0);
  dn := coalesce(r.allin_down, 0);
  plan := coalesce((select d.plan from days d where d.athlete_id = p_athlete and d.date = p_date),
                   current_plan(p_athlete, p_date), '[]'::jsonb);

  for ex in select * from jsonb_array_elements(plan) loop
    tgt := greatest(coalesce((ex ->> 'target_reps')::int, 1), 1);
    n := (ex ->> 'sets')::int;
    select count(*) filter (where s.review in ('accepted', 'corrected') and coalesce(s.confirmed, 0) >= tgt),
           count(*) filter (where s.review not in ('pending') and coalesce(s.confirmed, 0) < tgt)
           + case when ended then n - count(*) filter (where s.claimed is not null) else 0 end
      into n_yes, n_no
    from set_logs s
    where s.athlete_id = p_athlete and s.date = p_date and s.exercise_id = (ex ->> 'id')::bigint and s.set_no <= n;
    st := case when n_no > 0 then 'miss' when n_yes >= n then 'done' else 'wait' end;
    if st = 'done' then done := done + 1; elsif st = 'miss' then miss := miss + 1; else wait := wait + 1; end if;
    items := items || jsonb_build_object('id', ex -> 'id', 'name', ex ->> 'name', 'state', st);
  end loop;

  if test then
    select coalesce(sum(t.points), 0), max(t.mult) into pts, k from theory_points t
    where t.athlete_id = p_athlete and t.date = p_date;
  else
    select coalesce(sum(s.points), 0), max(s.mult) into pts, k from set_logs s
    where s.athlete_id = p_athlete and s.date = p_date and s.points is not null;
  end if;
  k := coalesce(k, trim_scale(round(streak_mult(r, day_streak(p_athlete, p_date)), 2)), 1);
  m := greatest(0.1, k + up * done - dn * miss);
  best := greatest(0.1, k + up * (done + wait) - dn * miss);
  bonus := round(pts * (m / k - 1));

  return json_build_object(
    'price', p.price, 'up', trim_scale(up), 'down', trim_scale(dn), 'k', trim_scale(k),
    'done', done, 'missed', miss, 'waiting', wait, 'total', done + miss + wait, 'items', items,
    'mult', trim_scale(round(m, 2)), 'best', trim_scale(round(best, 2)),
    'points', pts, 'bonus', bonus, 'final', ended and wait = 0, 'test', test,
    'applied', (select coalesce(sum(l.rating), 0) from ledger l
                where l.athlete_id = p_athlete and l.date = p_date and l.kind = 'modifier'));
end $$;

-- Записать в журнал разницу между тем, что модификатор должен дать за день, и тем, что уже записано.
-- Пока день не закончен или не всё проверено — должен 0. Покупку отменили — запись откатывается.
create or replace function public.allin_apply(p_athlete uuid, p_date date) returns void
language plpgsql security definer set search_path = public as $$
declare
  s     json := allin_state(p_athlete, p_date);
  want  int := 0;
  have  int;
  delta int;
begin
  if s is not null and (s ->> 'test')::boolean then return; end if;
  if s is not null and (s ->> 'final')::boolean then want := (s ->> 'bonus')::int; end if;
  select coalesce(sum(rating), 0) into have from ledger
  where athlete_id = p_athlete and date = p_date and kind = 'modifier';
  delta := want - have;
  if delta = 0 then return; end if;
  insert into ledger (athlete_id, date, kind, amount, rating, note)
  values (p_athlete, p_date, 'modifier', greatest(delta, -balance_of(p_athlete)), delta,
          case when s is null then 'Всё или ничего отменено'
               else case when have <> 0 then 'Пересмотр: ' else '' end
                    || 'Всё или ничего: сделано ' || (s ->> 'done') || ' из ' || (s ->> 'total')
                    || ' упражнений · очки дня ×' || (s ->> 'mult') end);
end $$;

-- Для экрана: состояние дня атлета (своего или, админу, любого).
-- Атлет в тестовый период не видит теоретических очков — как и везде.
create or replace function public.allin_day(p_date date, p_athlete uuid default null) returns json
language plpgsql security definer set search_path = public as $$
declare
  who uuid := coalesce(p_athlete, auth.uid());
  s   jsonb;
begin
  if auth.uid() is null then raise exception 'Нужно войти'; end if;
  if who <> auth.uid() and not is_admin() then raise exception 'Нет доступа'; end if;
  s := allin_state(who, p_date)::jsonb;
  if s is null then return null; end if;
  if (s ->> 'test')::boolean and not is_admin() then
    s := s || jsonb_build_object('points', null, 'bonus', null);
  end if;
  return s::json;
end $$;

-- ───────────── Покупка ─────────────

-- Купить «Всё или ничего» на тренировочный день: только заранее, не больше лимита в неделю.
create or replace function public.buy_allin(p_date date) returns public.purchases
language plpgsql security definer set search_path = public as $$
declare
  uid   uuid := auth.uid();
  today date := app_today();
  r     public.rules := rules_for(app_today());
  cnt   int;
  bal   int;
  res   public.purchases;
begin
  if uid is null then raise exception 'Нужно войти'; end if;
  if (select role from profiles where id = uid) <> 'athlete' then raise exception 'Покупает атлет'; end if;
  perform lock_athlete(uid);
  if p_date <= today then raise exception '«Всё или ничего» покупается заранее, до начала дня'; end if;
  if p_date > today + 60 then raise exception 'Можно купить не дальше чем на 60 дней вперёд'; end if;
  if r.allin_price is null then raise exception 'Цену «Всё или ничего» Тимур ещё не задал'; end if;
  if day_status_of(uid, p_date) is distinct from 'training' then raise exception 'В этот день нет тренировки'; end if;
  if exists (select 1 from purchases where athlete_id = uid and date = p_date and status = 'active') then
    raise exception 'На этот день уже есть покупка';
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

-- Числа «Всё или ничего» в сегодняшних правилах. Вызывается сразу после save_rules.
create or replace function public.save_allin(p jsonb) returns public.rules
language plpgsql security definer set search_path = public as $$
declare
  r public.rules;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  update rules set
    allin_price = (p ->> 'allin_price')::int, allin_up = (p ->> 'allin_up')::numeric,
    allin_down = (p ->> 'allin_down')::numeric, allin_limit_week = (p ->> 'allin_limit_week')::int
  where valid_from = app_today()
  returning * into r;
  if not found then raise exception 'Сначала сохрани правила'; end if;
  return r;
end $$;

-- Как в v3, плюс: лимит в неделю считает только выходные, и день с другой покупкой не купить.
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

-- Как в v3, только подпись в журнале — по тому, что куплено.
create or replace function public.cancel_purchase(p_id bigint) returns public.purchases
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
  values (p.athlete_id, p.date, 'refund', p.price,
          case when p.kind = 'allin' then 'Отмена «Всё или ничего» на ' else 'Отмена выходного на ' end
          || bot_day_title(p.date));
  return res;
end $$;

-- Как в 0011, плюс: «Всё или ничего» остаётся, если день по-прежнему тренировка.
-- Стал выходным, больничным или «занят» — покупка отменяется, очки возвращаются.
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
  if found and not (pur.kind = 'allin' and p_status = 'training') then
    update purchases set status = 'cancelled', cancelled_at = now() where id = pur.id;
    insert into ledger (athlete_id, date, kind, amount, note)
    values (p_athlete, p_date, 'refund', pur.price,
            case when pur.kind = 'allin' then 'Тимур поменял день: очки за «Всё или ничего» вернулись'
                 else 'Тимур поменял день: очки за выходной вернулись' end);
    if pur.kind = 'allin' then perform allin_apply(p_athlete, p_date); end if;
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

-- ───────────── Итог дня ─────────────

-- Как в 0008, плюс: итог «Всё или ничего» за прошедшие дни.
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

-- ───────────── Бот ─────────────

-- Как в 0008, плюс: в итоге дня — «Всё или ничего», покупка и отмена подписаны по тому, что куплено.
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
  ai      json;
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
      ai := allin_state(a.id, yday);
      if ai is not null then
        body := body || E'\n' || 'Всё или ничего: сделано ' || (ai ->> 'done') || ' из ' || (ai ->> 'total')
                || ' упражнений · ×' || (ai ->> 'mult')
                || case when (ai ->> 'final')::boolean and not (ai ->> 'test')::boolean
                        then ' · ' || case when (ai ->> 'bonus')::int >= 0 then '+' else '−' end || abs((ai ->> 'bonus')::int)
                        when (ai ->> 'final')::boolean then '' else ' · итог после проверки' end;
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
      select 'buy:' || p.id, who || case when p.kind = 'allin' then ': куплен день «Всё или ничего» на ' else ': куплен выходной на ' end
             || bot_day_title(p.date) || ', списано ' || p.price || '.'
        from purchases p where p.athlete_id = a.id and p.status = 'active' and p.created_at > now() - interval '2 days'
      union all
      select 'cancel:' || p.id, who || case when p.kind = 'allin' then ': «Всё или ничего» на ' else ': выходной на ' end
             || bot_day_title(p.date) || case when p.kind = 'allin' then ' отменено' else ' отменён' end || ', очки вернулись.'
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
  public.buy_phone(), public.save_complexes(jsonb, int), public.complex_schedule(uuid, date, date),
  public.buy_allin(date), public.save_allin(jsonb), public.allin_day(date, uuid)
to authenticated;
grant execute on function public.bot_outbox(), public.bot_mark_sent(text) to service_role;
