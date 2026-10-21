-- Трекер тренировок · 0020: «Подтверждено по видео» в «Проверке» обновляется каждый день.
-- Вчерашние подтверждения видны только до конца grace_hours (03:00), пока у друга ещё можно
-- отметить видео за вчера. Потом в блоке остаются только сегодняшние. Очки за подходы не меняются:
-- они начислены, когда бот принял подход. Повторный запуск безопасен.

create or replace function public.video_confirmed() returns json
language plpgsql stable security definer set search_path = public as $$
declare
  since date := app_today()
    - case when extract(hour from app_now()) < (select grace_hours from settings where id = 1) then 1 else 0 end;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  return (select coalesce(json_agg(to_jsonb(l) || jsonb_build_object('no', video_no(d.plan, l.exercise_id, l.set_no))
                                   order by l.date desc, l.id), '[]'::json)
          from set_logs l left join days d on d.athlete_id = l.athlete_id and d.date = l.date
          where l.auto and l.review = 'accepted' and l.date >= since);
end $$;
