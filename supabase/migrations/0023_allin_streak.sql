-- Трекер тренировок · 0023: «Всё или ничего» открывается серией от 7 дней.
-- Купить можно, только пока текущая серия (как в wallet: streak_at на сегодня) не меньше 7.
-- Пропустил день — серия обнулилась, ALL IN снова закрыт. Уже купленное не трогаем.
-- Как живая buy_allin, плюс эта проверка. Повторный запуск безопасен.

create or replace function public.buy_allin(p_date date) returns public.purchases
language plpgsql security definer set search_path = public as $$
declare
  uid   uuid := auth.uid();
  today date := app_today();
  r     public.rules := rules_for(app_today());
  need  constant int := 7;
  s     int;
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
  s := streak_at(uid, today);
  if s < need then
    raise exception '«Всё или ничего» открывается при серии от % дней, сейчас %', need, s;
  end if;
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
