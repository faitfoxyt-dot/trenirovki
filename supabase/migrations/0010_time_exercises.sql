-- Трекер тренировок · 0010: упражнения на время (секунды).
-- У упражнения единица: 'reps' — повторы, 'sec' — секунды (планка и т.п.).
-- Для «на время» всё то же самое, только в секундах: цель, отметки, очки за секунду,
-- за полный подход (продержался не меньше цели) и бонус за секунды сверх цели с потолком в день.
-- Повторный запуск безопасен.

alter table public.exercises add column if not exists unit text not null default 'reps';
do $$ begin
  alter table public.exercises add constraint exercises_unit_check check (unit in ('reps', 'sec'));
exception when duplicate_object then null; end $$;

-- Снимок комплекса на день теперь знает единицу.
create or replace function public.current_plan() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'name', name, 'unit', unit, 'sets', sets, 'target_reps', target_reps)
         order by position, id), '[]'::jsonb)
  from exercises where active
$$;

-- Как в v3.1, плюс единица в снимке.
create or replace function public.set_day_plan(p_athlete uuid, p_date date, p_plan jsonb, p_note text) returns public.days
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
    select jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'unit', e.unit, 'sets', (x ->> 'sets')::int,
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

-- Итог дня в боте: секунды подписаны «с».
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
  sec   boolean;
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
  public.buy_phone()
to authenticated;
grant execute on function public.bot_outbox(), public.bot_mark_sent(text) to service_role;
