-- Трекер тренировок · 0019: выбор упражнения подтверждают один раз.
-- Друг перетыкивает варианты на сайте сколько угодно, а «Подтвердить» сохраняет выбор навсегда:
-- второй раз choose_exercise для того же места отказывает. Как в 0018, плюс эта проверка.
-- Повторный запуск безопасен.

create or replace function public.choose_exercise(p_date date, p_i int, p_k int) returns public.days
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  d   public.days;
  x   jsonb;
  o   jsonb;
begin
  if uid is null then raise exception 'Нужно войти'; end if;
  if p_date is distinct from app_today() then raise exception 'Выбрать можно только на сегодня'; end if;
  perform lock_athlete(uid);
  d := ensure_day(uid, p_date);
  x := d.plan -> p_i;
  o := x -> 'pick' -> p_k;
  if d.status is distinct from 'training' or o is null or jsonb_typeof(o) <> 'object' then
    raise exception 'Тут нечего выбирать';
  end if;
  if jsonb_typeof(x -> 'chosen') = 'number' then raise exception 'Выбор уже подтверждён'; end if;
  if exists (select 1 from set_logs s where s.athlete_id = uid and s.date = p_date
             and s.exercise_id = (x ->> 'id')::bigint and s.claimed is not null) then
    raise exception 'Подход уже отмечен — выбор не поменять';
  end if;
  update days set
    plan = jsonb_set(plan, array[p_i::text], (x - 'price' - 'top' - 'times' - 'eff') || jsonb_build_object(
      'id', o -> 'id', 'name', o -> 'name', 'unit', o -> 'unit', 'target_reps', o -> 'target_reps', 'chosen', p_k)
      || jsonb_strip_nulls(jsonb_build_object('price', o -> 'price', 'top', o -> 'top', 'times', o -> 'times', 'eff', o -> 'eff'))),
    updated_at = now()
  where athlete_id = uid and date = p_date
  returning * into d;
  return d;
end $$;
