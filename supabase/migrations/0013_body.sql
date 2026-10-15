-- Трекер тренировок · v3.10: взвешивание.
-- Атлет раз в день записывает вес и процент жира (вкладка «Тело»), бот добавляет их в итог дня.
-- Можно выполнять повторно.

-- ───────────── Таблица ─────────────

create table if not exists public.body_checks (
  athlete_id uuid not null references public.profiles (id) on delete cascade,
  date       date not null,
  weight     numeric(4, 1) not null check (weight between 25 and 300),     -- кг
  fat        numeric(3, 1) check (fat is null or fat between 2 and 70),    -- % жира, если весы показывают
  updated_at timestamptz not null default now(),
  primary key (athlete_id, date)
);

alter table public.body_checks enable row level security;
drop policy if exists "свои или админ" on public.body_checks;
-- Читает сам атлет и админ; пишут только функции ниже.
create policy "свои или админ" on public.body_checks
  for select to authenticated using (athlete_id = auth.uid() or public.is_admin());

-- ───────────── Функции ─────────────

-- Взвешивание за сегодня: повторная запись заменяет цифры (в итог идёт последнее).
create or replace function public.save_body(p_weight numeric, p_fat numeric)
returns public.body_checks
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  res public.body_checks;
begin
  if uid is null then raise exception 'Нужно войти'; end if;
  if is_admin() then raise exception 'Вес записывает сам атлет'; end if;
  if p_weight is null or p_weight < 25 or p_weight > 300 then raise exception 'Вес — от 25 до 300 кг'; end if;
  if p_fat is not null and (p_fat < 2 or p_fat > 70) then raise exception 'Жир — от 2 до 70 %%'; end if;
  insert into body_checks (athlete_id, date, weight, fat)
  values (uid, app_today(), round(p_weight, 1), round(p_fat, 1))
  on conflict (athlete_id, date) do update set
    weight = excluded.weight, fat = excluded.fat, updated_at = now()
  returning * into res;
  return res;
end $$;

-- Удалить взвешивание: админ — любое, атлет — только своё сегодняшнее.
create or replace function public.delete_body(p_athlete uuid, p_date date) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Нужно войти'; end if;
  if not is_admin() and (p_athlete is distinct from auth.uid() or p_date <> app_today()) then
    raise exception 'Удалить можно только сегодняшнее взвешивание';
  end if;
  delete from body_checks where athlete_id = p_athlete and date = p_date;
end $$;

-- 72.4 → «72,4».
create or replace function public.bot_num(v numeric) returns text
language sql immutable as $$ select replace(to_char(v, 'FM990.0'), '.', ',') $$;

-- Разница с прошлым взвешиванием: «−0,3», «+0,2», «±0».
create or replace function public.bot_delta(v numeric) returns text
language sql immutable as $$
  select case when v is null then null when v = 0 then '±0'
              when v > 0 then '+' || bot_num(v) else '−' || bot_num(-v) end
$$;

-- Итог дня в боте: как в 0010, плюс строка взвешивания.
create or replace function public.bot_summary_text(p_athlete uuid, p_date date) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  p     profiles;
  d     days;
  m     morning_checks;
  b     body_checks;
  pb    body_checks;
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
  public.buy_allin(date), public.save_allin(jsonb), public.allin_day(date, uuid),
  public.save_body(numeric, numeric), public.delete_body(uuid, date)
to authenticated;
grant execute on function public.bot_outbox(), public.bot_mark_sent(text) to service_role;
