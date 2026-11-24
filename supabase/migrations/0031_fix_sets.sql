-- 0031: генерал правит подходы прошедшего дня («Календарь» → «Поправить подходы»).
-- Для каждого подхода плана — число повторов (секунд): null — не трогать, 0 — не засчитан.
-- Новый подход вписывается сразу принятым; у вписанного другом — «принято» или «исправлено».
-- Видео, которое ждало повторов (tg_videos.status = 'waiting'), привязывается к подходу, бот ставит 🫡.
-- Потом: очки подхода (award_set), подходы следующих дней, где множитель серии стал другим,
-- и settle() — штраф за пропуск возвращается, «Всё или ничего», рулетка и событие дня пересчитываются.
-- Только прошедшие дни, последние 30 (дальше settle штрафы не смотрит). Возвращает новые записи очков и баланс.

create or replace function public.fix_sets(p_athlete uuid, p_date date, p_items jsonb, p_comment text default null)
returns json
language plpgsql security definer set search_path = public as $$
declare
  today   date := app_today();
  st      public.settings;
  d       public.days;
  it      jsonb;
  ex      jsonb;
  v_ex    bigint;
  v_n     int;
  v_reps  int;
  l       public.set_logs;
  v       public.tg_videos;
  vno     int;
  v_note  text := nullif(trim(coalesce(p_comment, '')), '');
  fresh   boolean;
  changed int := 0;
  k       numeric;
  mark    bigint;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  select * into st from settings where id = 1;
  if p_date >= today then raise exception 'Сегодняшний день друг заполняет сам'; end if;
  if p_date < today - 30 then raise exception 'Править можно только последние 30 дней'; end if;
  if st.start_date is null or p_date < st.start_date then raise exception 'До старта'; end if;
  if length(v_note) > 200 then raise exception 'Комментарий длиннее 200 символов'; end if;

  perform lock_athlete(p_athlete);
  select * into d from days where athlete_id = p_athlete and date = p_date;
  if d.status is distinct from 'training' or d.plan is null then raise exception 'В этот день нет тренировки'; end if;
  mark := coalesce((select max(id) from ledger), 0);

  for it in select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_ex := (it ->> 'exercise_id')::bigint;
    v_n := (it ->> 'set_no')::int;
    v_reps := (it ->> 'reps')::int;
    ex := null;
    select value into ex from jsonb_array_elements(d.plan) where (value ->> 'id')::bigint = v_ex;
    if ex is null then raise exception 'Этого упражнения нет в плане дня'; end if;
    if v_n is null or v_n < 1 or v_n > (ex ->> 'sets')::int then raise exception 'Лишний подход'; end if;
    continue when v_reps is null;
    if v_reps < 0 or v_reps > 1000 then raise exception 'Число от 0 до 1000'; end if;

    select * into l from set_logs
    where athlete_id = p_athlete and date = p_date and exercise_id = v_ex and set_no = v_n
    for update;
    fresh := not found;
    continue when fresh and v_reps = 0;
    continue when not fresh and l.review <> 'pending' and l.confirmed = v_reps;

    vno := video_no(d.plan, v_ex, v_n);
    select * into v from tg_videos
    where athlete_id = p_athlete and date = p_date and no = vno and status = 'waiting'
    order by created_at desc limit 1;

    if fresh then
      insert into set_logs (athlete_id, date, exercise_id, set_no, claimed, has_video, video_url,
                            review, confirmed, comment, reviewed_at)
      values (p_athlete, p_date, v_ex, v_n, v_reps, v.url is not null, v.url,
              case when v_reps = 0 then 'rejected' else 'accepted' end::review_status, v_reps,
              coalesce(v_note, 'Вписал крутой генерал'), now())
      returning * into l;
    else
      update set_logs set
        claimed     = coalesce(claimed, v_reps),
        review      = case when v_reps = 0 then 'rejected'
                           when v_reps = coalesce(claimed, v_reps) then 'accepted'
                           else 'corrected' end::review_status,
        confirmed   = v_reps,
        comment     = coalesce(v_note, 'Исправил крутой генерал'),
        has_video   = has_video or v.url is not null,
        video_url   = coalesce(video_url, v.url),
        reviewed_at = now(),
        updated_at  = now()
      where id = l.id
      returning * into l;
    end if;

    if v.url is not null then
      update tg_videos set
        status  = case when message_id = v.message_id then 'matched' else 'bad' end,
        set_id  = case when message_id = v.message_id then l.id end,
        react   = case when message_id = v.message_id then '🫡' else '' end,
        reacted = false, updated_at = now()
      where athlete_id = p_athlete and date = p_date and no = vno and status = 'waiting';
    end if;

    perform award_set(l.id);
    update ledger set note = '✏️ Генерал: ' || regexp_replace(note, '^Пересмотр: ', '')
    where set_id = l.id and id > mark;
    changed := changed + 1;
  end loop;

  if changed > 0 then
    -- Серия следующих дней могла стать другой — пересчитать подходы, где множитель серии поменялся.
    for l in select s.* from set_logs s
             where s.athlete_id = p_athlete and s.date > p_date and s.date <= today and s.points is not null
             order by s.date, s.id loop
      k := trim_scale(round(streak_mult(rules_for(l.date), day_streak(p_athlete, l.date)), 2));
      if k is distinct from l.mult then perform award_set(l.id); end if;
    end loop;
    perform settle(p_athlete);
  end if;

  return json_build_object(
    'changed', changed,
    'ledger', (select coalesce(json_agg(to_jsonb(x) order by x.id), '[]'::json)
               from ledger x where x.athlete_id = p_athlete and x.id > mark),
    'balance', balance_of(p_athlete));
end $$;

revoke all on function public.fix_sets(uuid, date, jsonb, text) from public, anon;
grant execute on function public.fix_sets(uuid, date, jsonb, text) to authenticated;
