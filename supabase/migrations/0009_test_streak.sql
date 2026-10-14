-- Трекер тренировок · 0009: у тестового периода своя серия.
-- Серия считается только по дням того же режима, что и сам день:
--   настоящий день — по настоящим дням, тестовые дни пропускаются (не продлевают и не рвут);
--   тестовый день — по тестовым дням, настоящие пропускаются.
-- Закончился тестовый период — его дни в настоящую серию не идут.
-- Включил тестовый период по ошибке и выключил — настоящая серия не сбросилась.
-- Выполняется сам после Merge (GitHub Actions «SQL в Supabase»). Повторный запуск безопасен.

-- Тестовый ли день: по правилам, которые действовали в этот день.
create or replace function public.is_test_day(p_date date) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select calibration from rules where valid_from <= p_date order by valid_from desc limit 1), true)
$$;

-- Серия на день p_date среди дней режима p_test. Дни другого режима пропускаются,
-- как выходные. Сегодняшний несделанный день серию не рвёт, пока не закончился.
create or replace function public.streak_in(p_athlete uuid, p_date date, p_test boolean) returns int
language plpgsql stable security definer set search_path = public as $$
declare
  start date := (select start_date from settings where id = 1);
  d     date := p_date;
  n     int := 0;
begin
  if start is null then return 0; end if;
  while d >= start and d > p_date - 400 loop
    if is_test_day(d) = p_test and day_status_of(p_athlete, d) = 'training' then
      if day_done(p_athlete, d) then
        n := n + 1;
      elsif d < app_today() then
        exit;
      end if;
    end if;
    d := d - 1;
  end loop;
  return n;
end $$;

-- Серия на день — в режиме этого дня.
create or replace function public.streak_at(p_athlete uuid, p_date date) returns int
language sql stable security definer set search_path = public as $$
  select streak_in(p_athlete, p_date, is_test_day(p_date))
$$;

-- Серия этого дня, если он будет сделан: дни того же режима подряд до него + он сам.
create or replace function public.day_streak(p_athlete uuid, p_date date) returns int
language sql stable security definer set search_path = public as $$
  select streak_in(p_athlete, p_date - 1, is_test_day(p_date)) + 1
$$;

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
  public.buy_phone()
to authenticated;
grant execute on function public.bot_outbox(), public.bot_mark_sent(text) to service_role;
