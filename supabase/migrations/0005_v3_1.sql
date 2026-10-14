-- Трекер тренировок · v3.1: правки Тимура после первой проверки v3.
-- Очки по каждому упражнению, штраф в % от баланса, множитель серии на весь подход,
-- пропуск = не сделан хоть один подход, теоретические очки на калибровке (видит только админ),
-- план на конкретный день, ручное начисление, очистка тестовых данных, показ правил атлету.
-- Применять один раз целиком в Supabase → SQL Editor и сразу смёржить PR v3.1.

-- ───────────── Правила ─────────────

-- Очки за повтор, полный подход, повтор сверх цели и рост — свои у каждого упражнения:
-- per_exercise = {"<id упражнения>": {"rep": 1, "set": 5, "over": 1, "growth": 20}}.
alter table public.rules
  add column per_exercise jsonb not null default '{}'::jsonb,
  add column miss_penalty_pct numeric check (miss_penalty_pct between 0 and 100);

-- Если Тимур уже вписал общие числа, раздаём их всем упражнениям.
update public.rules r set per_exercise = coalesce((
  select jsonb_object_agg(e.id::text, jsonb_strip_nulls(jsonb_build_object(
    'rep', r.points_per_rep, 'set', r.points_per_set, 'over', r.bonus_over, 'growth', r.bonus_growth)))
  from public.exercises e), '{}'::jsonb)
where coalesce(r.points_per_rep, r.points_per_set, r.bonus_over, r.bonus_growth) is not null;

alter table public.rules
  drop column points_per_rep,
  drop column points_per_set,
  drop column bonus_over,
  drop column bonus_growth,
  drop column miss_penalty;

-- Показывать атлету вкладку правил (только чтение).
alter table public.settings add column show_rules boolean not null default false;

-- Задание на день от Тимура: текст рядом с планом.
alter table public.days add column note text check (note is null or length(note) <= 500);

alter type public.ledger_kind add value if not exists 'manual';

-- Теоретические очки на калибровке: сколько дал бы подход по правилам. Видит только админ.
create table public.theory_points (
  set_id     bigint primary key references public.set_logs (id) on delete cascade,
  athlete_id uuid not null references public.profiles (id) on delete cascade,
  date       date not null,
  points     int not null,
  bonus      int not null default 0
);
alter table public.theory_points enable row level security;
create policy "только админ" on public.theory_points
  for select to authenticated using (public.is_admin());

-- ───────────── День: сделан ли весь план ─────────────

-- {отмечено подходов из плана, всего подходов в плане}.
create function public.day_counts(p_athlete uuid, p_date date) returns int[]
language sql stable security definer set search_path = public as $$
  with p as (
    select coalesce((select plan from days where athlete_id = p_athlete and date = p_date), current_plan()) as plan
  ), e as (
    select (x ->> 'id')::bigint as id, (x ->> 'sets')::int as sets from p, jsonb_array_elements(p.plan) x
  )
  select array[
    (select count(*)::int from set_logs s join e on e.id = s.exercise_id and s.set_no <= e.sets
     where s.athlete_id = p_athlete and s.date = p_date and s.claimed is not null),
    (select coalesce(sum(sets), 0)::int from e)]
$$;

create function public.day_done(p_athlete uuid, p_date date) returns boolean
language sql stable security definer set search_path = public as $$
  select c[1] >= c[2] from (select day_counts(p_athlete, p_date) c) t
$$;

-- Серия: тренировочные дни подряд, где сделан весь план. Выходные, купленные,
-- больничные и «занят» серию не продлевают и не рвут. Сегодняшний день не рвёт, пока не закончился.
create or replace function public.streak_at(p_athlete uuid, p_date date) returns int
language plpgsql stable security definer set search_path = public as $$
declare
  start date := (select start_date from settings where id = 1);
  d     date := p_date;
  n     int := 0;
begin
  if start is null then return 0; end if;
  while d >= start and d > p_date - 400 loop
    if day_status_of(p_athlete, d) = 'training' then
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

-- ───────────── Очки за подход ─────────────

-- (повторы × за повтор + за полный подход + сверх цели) × множитель серии.
-- Бонус сверх цели ограничен потолком в день (до умножения).
-- На калибровке очки не начисляются, а пишутся в theory_points — только для админа.
-- Калибровка или нет — решают правила дня подхода.
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
  -- На калибровке теорию считаем по самым свежим числам, которые вписал Тимур.
  if cal then r := rules_for(app_today() + 1); end if;
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
      if r.bonus_cap_day is not null then
        if cal then
          select coalesce(sum(bonus), 0) into other from theory_points
          where athlete_id = l.athlete_id and date = l.date and set_id <> l.id;
        else
          select coalesce(sum(bonus), 0) into other from set_logs
          where athlete_id = l.athlete_id and date = l.date and id <> l.id;
        end if;
        bon := greatest(0, least(bon, r.bonus_cap_day - other));
      end if;
    end if;
    mult := streak_mult(r, streak_at(l.athlete_id, l.date));
    total := round((base + bon) * mult);
  end if;

  -- Калибровка: только теория.
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

-- Как в v3, но: пропуск = не сделан хоть один подход плана; штраф — % от баланса;
-- бонус за рост — свой у каждого упражнения.
create or replace function public.settle(p_athlete uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  today date := app_today();
  start date := (select start_date from settings where id = 1);
  d     date;
  wk    date;
  r     rules;
  c     int[];
  bal   int;
  pen   int;
  sum_g int;
  names text;
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

  for i in 1..5 loop
    wk := week_start(today) - 7 * i;
    continue when wk + 6 < start;
    r := rules_for(wk + 6);
    continue when coalesce(r.calibration, true);
    continue when exists (select 1 from ledger where athlete_id = p_athlete and key = 'growth:' || wk);
    continue when exists (select 1 from set_logs where athlete_id = p_athlete and date between wk - 7 and wk + 6
                          and review = 'pending' and claimed is not null);
    select coalesce(sum(coalesce((r.per_exercise -> cur.exercise_id::text ->> 'growth')::int, 0)), 0),
           string_agg(x.name, ', ' order by x.position, x.id)
      into sum_g, names
    from (select exercise_id, max(confirmed) best from set_logs
          where athlete_id = p_athlete and date between wk and wk + 6 and review in ('accepted', 'corrected')
          group by exercise_id) cur
    join (select exercise_id, max(confirmed) best from set_logs
          where athlete_id = p_athlete and date between wk - 7 and wk - 1 and review in ('accepted', 'corrected')
          group by exercise_id) prev using (exercise_id)
    join exercises x on x.id = cur.exercise_id
    where cur.best > prev.best and coalesce((r.per_exercise -> cur.exercise_id::text ->> 'growth')::int, 0) > 0;
    if sum_g > 0 then
      insert into ledger (athlete_id, date, kind, amount, rating, note, key)
      values (p_athlete, wk + 6, 'bonus_growth', sum_g, sum_g, 'Рост за неделю: ' || names, 'growth:' || wk);
    end if;
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

-- ───────────── Сохранение правил ─────────────

create or replace function public.save_rules(p jsonb) returns public.rules
language plpgsql security definer set search_path = public as $$
declare
  r public.rules;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  r := jsonb_populate_record(null::public.rules, p);
  r.valid_from := app_today() + 1;
  r.calibration := coalesce(r.calibration, true);
  r.per_exercise := coalesce(r.per_exercise, '{}'::jsonb);
  r.saved_at := now();
  insert into rules values (r.*)
  on conflict (valid_from) do update set
    calibration = excluded.calibration, per_exercise = excluded.per_exercise,
    streak_from = excluded.streak_from, streak_step = excluded.streak_step, streak_max = excluded.streak_max,
    bonus_cap_day = excluded.bonus_cap_day, miss_penalty_pct = excluded.miss_penalty_pct,
    rest_day_price = excluded.rest_day_price, purchase_limit_week = excluded.purchase_limit_week,
    phone_price = excluded.phone_price, saved_at = excluded.saved_at
  returning * into r;
  -- Пересчитать теоретические очки калибровки по новым числам.
  perform award_set(s.id) from set_logs s
  where s.date > app_today() - 60 and s.review in ('accepted', 'corrected')
    and coalesce((rules_for(s.date)).calibration, true);
  return r;
end $$;

-- Счёт атлета. Админу ещё и сумма теоретических очков калибровки.
create or replace function public.wallet(p_athlete uuid default null) returns json
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
    'mult', streak_mult(r, s), 'phone_price', r.phone_price,
    'theory', case when is_admin() then (select coalesce(sum(points), 0) from theory_points where athlete_id = who) end);
end $$;

-- ───────────── Новые действия админа ─────────────

-- Свой комплекс и задание на конкретный день (сегодня или позже).
-- p_plan = [{"id": 1, "sets": 4, "target_reps": 10}, …]; null — вернуть общий комплекс.
create function public.set_day_plan(p_athlete uuid, p_date date, p_plan jsonb, p_note text) returns public.days
language plpgsql security definer set search_path = public as $$
declare
  res    public.days;
  v_plan jsonb;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  if p_date < app_today() then raise exception 'Прошедший день менять нельзя'; end if;
  if p_plan is not null then
    if jsonb_typeof(p_plan) <> 'array' or jsonb_array_length(p_plan) = 0 then
      raise exception 'В плане дня нужно хотя бы одно упражнение';
    end if;
    select jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'sets', (x ->> 'sets')::int,
                                        'target_reps', (x ->> 'target_reps')::int) order by o)
      into v_plan
    from jsonb_array_elements(p_plan) with ordinality as t(x, o)
    join exercises e on e.id = (x ->> 'id')::bigint;
    if jsonb_array_length(coalesce(v_plan, '[]'::jsonb)) <> jsonb_array_length(p_plan) then
      raise exception 'В плане есть неизвестное упражнение';
    end if;
    if exists (select 1 from jsonb_array_elements(v_plan) x
               where (x ->> 'sets')::int not between 1 and 10
                  or ((x ->> 'target_reps') is not null and (x ->> 'target_reps')::int not between 1 and 1000)) then
      raise exception 'Подходов — от 1 до 10, цель — от 1 до 1000';
    end if;
  end if;

  perform set_day_status(p_athlete, p_date, 'training');
  update days set
    plan = case when p_plan is not null then v_plan
                when p_date = app_today() then current_plan() end,
    note = nullif(trim(p_note), ''),
    updated_at = now()
  where athlete_id = p_athlete and date = p_date
  returning * into res;
  return res;
end $$;

-- Начислить или снять очки вручную. Снятие не уводит баланс ниже нуля и не трогает рейтинг.
create function public.grant_points(p_athlete uuid, p_amount int, p_note text) returns public.ledger
language plpgsql security definer set search_path = public as $$
declare
  res public.ledger;
  bal int;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  if coalesce(p_amount, 0) = 0 then raise exception 'Укажи число очков'; end if;
  if length(trim(coalesce(p_note, ''))) = 0 then raise exception 'Напиши причину'; end if;
  perform lock_athlete(p_athlete);
  bal := balance_of(p_athlete);
  insert into ledger (athlete_id, date, kind, amount, rating, note)
  values (p_athlete, app_today(), 'manual', greatest(p_amount, -bal), greatest(p_amount, 0), 'Тимур: ' || trim(p_note))
  returning * into res;
  perform settle(p_athlete);
  return res;
end $$;

create function public.delete_idea(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  delete from ideas where id = p_id;
end $$;

-- Стереть всё, что накопил атлет: подходы, дни, утро, очки, покупки, больничные, идеи.
-- Аккаунт остаётся. Для тестового аккаунта.
create function public.reset_athlete(p_athlete uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  if (select role from profiles where id = p_athlete) is distinct from 'athlete' then
    raise exception 'Очищать можно только атлета';
  end if;
  perform lock_athlete(p_athlete);
  delete from ledger where athlete_id = p_athlete;
  delete from purchases where athlete_id = p_athlete;
  delete from sick_requests where athlete_id = p_athlete;
  delete from ideas where athlete_id = p_athlete;
  delete from set_logs where athlete_id = p_athlete;
  delete from morning_checks where athlete_id = p_athlete;
  delete from days where athlete_id = p_athlete;
  delete from bot_log where key like '%' || p_athlete::text || '%';
end $$;

-- ───────────── Бот: итог дня ─────────────
-- Как в v2, плюс: тренировка, где сделан не весь план, — пропуск.

create or replace function public.bot_summary_text(p_athlete uuid, p_date date) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  p     profiles;
  d     days;
  m     morning_checks;
  ex    jsonb;
  reps  text;
  vids  int;
  c     int[];
  lines text[] := '{}';
begin
  select * into p from profiles where id = p_athlete;
  select * into d from days where athlete_id = p_athlete and date = p_date;
  select * into m from morning_checks where athlete_id = p_athlete and date = p_date;

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
        select string_agg(coalesce(l.claimed::text, '—'), ' · ' order by g),
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
  end if;

  if m.muscles is not null or m.energy is not null then
    lines := lines || ('Утро: ' || coalesce(case m.muscles
        when 'ok' then 'готов' when 'sore' then 'так себе' when 'pain' then 'плохо' end, '—')
      || ', энергия ' || coalesce(m.energy::text, '—'));
  end if;

  return array_to_string(lines, E'\n');
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
  public.delete_idea(bigint), public.reset_athlete(uuid)
to authenticated;
grant execute on function public.bot_outbox(), public.bot_mark_sent(text) to service_role;
