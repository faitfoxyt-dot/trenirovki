-- Трекер тренировок · 0026: выходной на сегодня.
-- Покупается в тот же день, до полуночи. Цена — rules.rest_today_pct % баланса, но не меньше
-- rules.rest_today_min (оба пустые — не продаётся). День становится «купленным» (bought), как обычный
-- выходной: серию не рвёт и не продлевает, штрафа нет. Отменить нельзя. Уже сделанные сегодня подходы
-- остаются с очками. Нельзя в день ALL IN и пари и если план на сегодня уже сделан.
-- В недельный лимит выходных не входит (purchases.same_day).
-- Повторный запуск безопасен.

alter table public.rules add column if not exists rest_today_pct int;
alter table public.rules add column if not exists rest_today_min int;
alter table public.purchases add column if not exists same_day boolean not null default false;

-- Стартовые числа в действующие правила (если ещё не заданы).
update public.rules set
  rest_today_pct = coalesce(rest_today_pct, 15), rest_today_min = coalesce(rest_today_min, 10000)
where valid_from = (select max(valid_from) from public.rules);

-- Цена выходного на сегодня; null — не продаётся. Как restTodayPrice в js/logic.js.
create or replace function public.rest_today_price(r public.rules, p_balance int) returns int
language sql immutable as $$
  select case when r.rest_today_pct is null and r.rest_today_min is null then null
    else greatest(coalesce(r.rest_today_min, 0), round(greatest(p_balance, 0) * coalesce(r.rest_today_pct, 0) / 100.0)::int) end
$$;

create or replace function public.buy_rest_today() returns public.purchases
language plpgsql security definer set search_path = public as $$
declare
  uid   uuid := auth.uid();
  today date := app_today();
  r     public.rules := rules_for(app_today());
  bal   int;
  price int;
  res   public.purchases;
begin
  if uid is null then raise exception 'Нужно войти'; end if;
  if (select role from profiles where id = uid) <> 'athlete' then raise exception 'Выходной покупает атлет'; end if;
  perform lock_athlete(uid);
  bal := balance_of(uid);
  price := rest_today_price(r, bal);
  if price is null then raise exception 'Выходной на сегодня генерал ещё не продаёт'; end if;
  if day_status_of(uid, today) is distinct from 'training' then raise exception 'Сегодня и так нет тренировки'; end if;
  if exists (select 1 from purchases where athlete_id = uid and date = today and status = 'active') then
    raise exception 'Сегодня «Всё или ничего» — выходной не купить';
  end if;
  if exists (select 1 from pari_bet_at(uid, today)) then
    raise exception 'Сегодня идёт «За гранью предела» — выходной не купить';
  end if;
  if day_done(uid, today) then raise exception 'Сегодня всё уже сделано — выходной не нужен'; end if;
  if bal < price then
    raise exception 'Не хватает очков: нужно %, на балансе %', price, bal;
  end if;

  insert into purchases (athlete_id, date, price, prev_status, kind, same_day)
  values (uid, today, price, 'training', 'rest', true) returning * into res;
  insert into days (athlete_id, date, status) values (uid, today, 'bought')
  on conflict (athlete_id, date) do update set status = 'bought', updated_at = now();
  insert into ledger (athlete_id, date, kind, amount, note)
  values (uid, today, 'purchase', -price, 'Выходной на сегодня, ' || bot_day_title(today));
  return res;
end $$;

-- Выходной заранее: как было, только выходной на сегодня в недельный лимит не входит.
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
    where athlete_id = uid and status = 'active' and kind = 'rest' and not same_day
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

-- Настройки магазина после save_rules: плюс выходной на сегодня.
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
    pari_p50 = case when p ? 'pari_p50' then (p ->> 'pari_p50')::int else pari_p50 end,
    rest_today_pct = case when p ? 'rest_today_pct' then (p ->> 'rest_today_pct')::int else rest_today_pct end,
    rest_today_min = case when p ? 'rest_today_min' then (p ->> 'rest_today_min')::int else rest_today_min end
  where valid_from = app_today()
  returning * into r;
  if not found then raise exception 'Сначала сохрани правила'; end if;
  return r;
end $$;

-- ───────────── Права ─────────────

revoke execute on function public.buy_rest_today() from public, anon;
grant execute on function public.buy_rest_today() to authenticated;
