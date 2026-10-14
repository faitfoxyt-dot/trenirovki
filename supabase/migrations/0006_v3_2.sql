-- Трекер тренировок · v3.2: вторая порция правок Тимура.
-- Правила действуют сразу после сохранения, калибровка стала «тестовым периодом»,
-- список упражнений ведётся в «Правилах», бонус сверх цели и его потолок — у каждого упражнения,
-- бонуса за рост больше нет, очистка данных атлета — точечная, запись очков можно удалить.
-- Применять один раз целиком в Supabase → SQL Editor и сразу смёржить PR v3.2.

-- ───────────── Упражнения ─────────────

-- Удалённое из списка упражнение остаётся в базе ради старых подходов, но больше нигде не показывается.
alter table public.exercises add column archived boolean not null default false;

-- ───────────── Правила: сразу, а не со следующего дня ─────────────

-- То, что Тимур уже сохранил «на завтра», начинает действовать сегодня.
delete from public.rules
where valid_from = public.app_today() and exists (select 1 from public.rules where valid_from > public.app_today());
update public.rules set valid_from = public.app_today() where valid_from > public.app_today();

-- Потолок бонуса сверх цели переезжает в каждое упражнение (per_exercise.cap).
update public.rules r set per_exercise = (
  select jsonb_object_agg(k, v || jsonb_build_object('cap', r.bonus_cap_day)) from jsonb_each(r.per_exercise) e(k, v))
where r.bonus_cap_day is not null and r.per_exercise <> '{}'::jsonb;

-- Бонус за рост убран: из чисел упражнений его ключ тоже уходит.
update public.rules r set per_exercise = coalesce((
  select jsonb_object_agg(k, v - 'growth') from jsonb_each(r.per_exercise) e(k, v)), '{}'::jsonb);

alter table public.rules drop column bonus_cap_day;

create or replace function public.rules_now() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'current', to_json(rules_for(app_today())),
    'next',    to_json(rules_for(app_today())),
    'from',    app_today())
$$;

-- Сохранить правила: действуют с сегодняшнего дня. Уже начисленные очки не меняются.
create or replace function public.save_rules(p jsonb) returns public.rules
language plpgsql security definer set search_path = public as $$
declare
  r public.rules;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  r := jsonb_populate_record(null::public.rules, p);
  r.valid_from := app_today();
  r.calibration := coalesce(r.calibration, true);
  r.per_exercise := coalesce(r.per_exercise, '{}'::jsonb);
  r.saved_at := now();
  delete from rules where valid_from > app_today();
  insert into rules values (r.*)
  on conflict (valid_from) do update set
    calibration = excluded.calibration, per_exercise = excluded.per_exercise,
    streak_from = excluded.streak_from, streak_step = excluded.streak_step, streak_max = excluded.streak_max,
    miss_penalty_pct = excluded.miss_penalty_pct,
    rest_day_price = excluded.rest_day_price, purchase_limit_week = excluded.purchase_limit_week,
    phone_price = excluded.phone_price, saved_at = excluded.saved_at
  returning * into r;
  -- Пересчитать теоретические очки тестового периода по новым числам.
  perform award_set(s.id) from set_logs s
  where s.date > app_today() - 60 and s.review in ('accepted', 'corrected')
    and coalesce((rules_for(s.date)).calibration, true);
  return r;
end $$;

-- ───────────── Очки за подход ─────────────

-- (повторы × за повтор + за полный подход + сверх цели) × множитель серии.
-- Бонус сверх цели и его потолок в день — свои у каждого упражнения (rep, set, over, cap).
-- В тестовый период (calibration) очки не начисляются, а пишутся в theory_points по текущим числам.
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
  mult   numeric := 1;
  bon    int := 0;
  other  int;
  total  int := 0;
  cal    boolean;
  ok     boolean;
  delta  int;
  bal    int;
  note   text;
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

  if ok then
    base := l.confirmed * coalesce((pe ->> 'rep')::numeric, 0)
          + case when l.confirmed > 0 and (target is null or l.confirmed >= target)
                 then coalesce((pe ->> 'set')::numeric, 0) else 0 end;
    if target is not null and l.confirmed > target and coalesce((pe ->> 'over')::numeric, 0) > 0 then
      bon := round((l.confirmed - target) * (pe ->> 'over')::numeric);
      if (pe ->> 'cap') is not null then
        if cal then
          select coalesce(sum(t.bonus), 0) into other from theory_points t join set_logs s on s.id = t.set_id
          where t.athlete_id = l.athlete_id and t.date = l.date and s.exercise_id = l.exercise_id and t.set_id <> l.id;
        else
          select coalesce(sum(bonus), 0) into other from set_logs
          where athlete_id = l.athlete_id and date = l.date and exercise_id = l.exercise_id and id <> l.id;
        end if;
        bon := greatest(0, least(bon, (pe ->> 'cap')::int - other));
      end if;
    end if;
    mult := streak_mult(r, streak_at(l.athlete_id, l.date));
    total := round((base + bon) * mult);
  end if;

  if ok and cal then
    insert into theory_points (set_id, athlete_id, date, points, bonus)
    values (l.id, l.athlete_id, l.date, total, bon)
    on conflict (set_id) do update set points = excluded.points, bonus = excluded.bonus;
  else
    delete from theory_points where set_id = l.id;
  end if;

  ok := ok and not cal;
  update set_logs set points = case when ok then total end, bonus = case when ok then bon end where id = l.id;

  delta := case when ok then total else 0 end - coalesce(l.points, 0);
  if delta = 0 then return; end if;

  note := nm || ' · подход ' || l.set_no;
  if l.points is not null then note := 'Пересмотр: ' || note; end if;
  if ok and mult > 1 then note := note || ' · серия ×' || trim_scale(round(mult, 2))::text; end if;
  if ok and bon > 0 then note := note || ' · сверх цели +' || bon; end if;

  bal := balance_of(l.athlete_id);
  insert into ledger (athlete_id, date, kind, amount, rating, note, set_id)
  values (l.athlete_id, l.date, 'set', greatest(delta, -bal), delta, note, l.id);
end $$;

-- Штраф за пропуск и вехи цели. Бонуса за рост больше нет.
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

-- ───────────── Точечная очистка ─────────────

-- Стереть у атлета выбранное за период. p_what — что стирать:
-- sets (подходы и их теоретические очки), points (записи очков), purchases (покупки, день снова как был),
-- sick (запросы больничного), ideas, mornings (утро), days (планы, задания и статусы дней).
-- Пустые даты — за всё время. Возвращает, сколько строк стёрто по каждому пункту.
create function public.clear_athlete(p_athlete uuid, p_what text[], p_from date, p_to date) returns json
language plpgsql security definer set search_path = public as $$
declare
  f   date := coalesce(p_from, '1900-01-01');
  t   date := coalesce(p_to, '2999-12-31');
  n   int;
  res jsonb := '{}';
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  if (select role from profiles where id = p_athlete) is distinct from 'athlete' then
    raise exception 'Очищать можно только атлета';
  end if;
  if coalesce(array_length(p_what, 1), 0) = 0 then raise exception 'Выбери, что стереть'; end if;
  if f > t then raise exception 'Дата «с» позже даты «по»'; end if;
  perform lock_athlete(p_athlete);

  if 'purchases' = any(p_what) then
    update days d set status = p.prev_status, updated_at = now()
    from purchases p
    where p.athlete_id = p_athlete and p.date between f and t and p.status = 'active'
      and d.athlete_id = p_athlete and d.date = p.date and d.status = 'bought';
    delete from purchases where athlete_id = p_athlete and date between f and t;
    get diagnostics n = row_count; res := res || jsonb_build_object('purchases', n);
  end if;
  if 'points' = any(p_what) then
    delete from ledger where athlete_id = p_athlete and date between f and t;
    get diagnostics n = row_count; res := res || jsonb_build_object('points', n);
    update set_logs set points = null, bonus = null where athlete_id = p_athlete and date between f and t;
  end if;
  if 'sets' = any(p_what) then
    delete from set_logs where athlete_id = p_athlete and date between f and t;
    get diagnostics n = row_count; res := res || jsonb_build_object('sets', n);
  end if;
  if 'sick' = any(p_what) then
    delete from sick_requests where athlete_id = p_athlete and date between f and t;
    get diagnostics n = row_count; res := res || jsonb_build_object('sick', n);
  end if;
  if 'ideas' = any(p_what) then
    delete from ideas where athlete_id = p_athlete and (created_at at time zone 'Europe/Tallinn')::date between f and t;
    get diagnostics n = row_count; res := res || jsonb_build_object('ideas', n);
  end if;
  if 'mornings' = any(p_what) then
    delete from morning_checks where athlete_id = p_athlete and date between f and t;
    get diagnostics n = row_count; res := res || jsonb_build_object('mornings', n);
  end if;
  if 'days' = any(p_what) then
    delete from days where athlete_id = p_athlete and date between f and t;
    get diagnostics n = row_count; res := res || jsonb_build_object('days', n);
  end if;
  return res;
end $$;

-- Стереть всё (как в v3.1): то же, что очистка всего за всё время, плюс журнал бота.
create or replace function public.reset_athlete(p_athlete uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform clear_athlete(p_athlete, array['purchases', 'points', 'sets', 'sick', 'ideas', 'mornings', 'days'], null, null);
  delete from bot_log where key like '%' || p_athlete::text || '%';
end $$;

-- Удалить одну запись очков. Разовые записи (штраф за день, вехи) обнуляются, а не стираются,
-- иначе штраф за тот же день начислился бы снова.
create function public.delete_ledger(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  x public.ledger;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  select * into x from ledger where id = p_id;
  if not found then raise exception 'Запись не найдена'; end if;
  perform lock_athlete(x.athlete_id);
  if x.key is not null then
    update ledger set amount = 0, rating = 0,
      note = case when note like 'Удалено Тимуром: %' then note else 'Удалено Тимуром: ' || coalesce(note, '') end
    where id = p_id;
  else
    if x.set_id is not null then
      update set_logs set points = null, bonus = null where id = x.set_id;
    end if;
    delete from ledger where id = p_id;
  end if;
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
  public.set_day_plan(uuid, date, jsonb, text), public.grant_points(uuid, int, text),
  public.delete_idea(bigint), public.reset_athlete(uuid),
  public.clear_athlete(uuid, text[], date, date), public.delete_ledger(bigint)
to authenticated;
grant execute on function public.bot_outbox(), public.bot_mark_sent(text) to service_role;
