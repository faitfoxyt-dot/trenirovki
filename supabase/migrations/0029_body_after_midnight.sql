-- Трекер тренировок · 0029: взвешивание после полуночи идёт во вчерашний день.
-- До settings.grace_hours (03:00 по Таллину, как видео за вчера) save_body пишет вес за вчера,
-- после — за сегодня. Если итог вчерашнего дня бот уже отправил (в 00:05), вес приходит
-- отдельным сообщением в «Итоги» при следующем запуске бота.
-- Удалить атлет по-прежнему может только сегодняшнее взвешивание, вчерашнее — только «Изменить».
-- Повторный запуск безопасен.

-- День, за который сейчас пишется вес.
create or replace function public.body_day() returns date
language sql stable set search_path = public as $$
  select case when extract(hour from app_now()) < coalesce((select grace_hours from settings where id = 1), 0)
              then app_today() - 1 else app_today() end
$$;

-- Взвешивание за день body_day(): повторная запись заменяет цифры (в итог идёт последнее).
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
  values (uid, body_day(), round(p_weight, 1), round(p_fat, 1))
  on conflict (athlete_id, date) do update set
    weight = excluded.weight, fat = excluded.fat, updated_at = now()
  returning * into res;
  return res;
end $$;

-- Бот: как в 0014, плюс сообщение «взвешивание за …», если вес за вчера записан после итога.
create or replace function public.bot_outbox()
returns table (key text, chat_id bigint, topic int, msg text)
language plpgsql security definer set search_path = public as $$
declare
  cfg     bot_settings;
  st      settings;
  now_l   timestamp := app_now();
  today   date := app_today();
  yday    date := app_today() - 1;
  a       profiles;
  d       days;
  who     text;
  c       int[];
  pending int;
  body    text;
  pen     ledger;
  e       record;
  ai      json;
begin
  select * into cfg from bot_settings where id = 1;
  if not found or not cfg.enabled then return; end if;
  select * into st from settings where id = 1;

  if not exists (select 1 from bot_log l where l.key = 'hello') then
    key := 'hello'; chat_id := cfg.chat_id; topic := cfg.results_topic;
    msg := 'Бот на связи. Итог дня пишу сюда после 00:00, напоминание — в '
            || cfg.remind_hour || ':00, если день не заполнен.';
    return next;
  end if;

  for a in select * from profiles where role = 'athlete' and notify order by created_at loop
    perform settle(a.id);
    who := coalesce(nullif(a.name, ''), 'Атлет');

    -- Итог вчерашнего дня: один раз, после полуночи.
    if st.start_date is not null and yday >= st.start_date
       and not exists (select 1 from bot_log l where l.key = 'summary:' || a.id || ':' || yday) then
      perform ensure_day(a.id, yday);
      body := bot_summary_text(a.id, yday);
      select * into pen from ledger l where l.athlete_id = a.id and l.key = 'penalty:' || yday;
      if found then
        body := body || E'\n' || case when pen.amount < 0 then 'Штраф за пропуск: −' || -pen.amount
                                      else 'Штраф за пропуск: баланс уже 0' end;
      end if;
      ai := allin_state(a.id, yday);
      if ai is not null then
        body := body || E'\n' || 'Всё или ничего: сделано ' || (ai ->> 'done') || ' из ' || (ai ->> 'total')
                || ' упражнений · ×' || (ai ->> 'mult')
                || case when (ai ->> 'final')::boolean and not (ai ->> 'test')::boolean
                        then ' · ' || case when (ai ->> 'bonus')::int >= 0 then '+' else '−' end || abs((ai ->> 'bonus')::int)
                        when (ai ->> 'final')::boolean then '' else ' · итог после проверки' end;
      end if;
      select count(*) into pending from set_logs s
      where s.athlete_id = a.id and s.review = 'pending' and s.claimed is not null;
      if pending > 0 then
        body := body || E'\n' || 'Ждут проверки Тимура: ' || pending;
      end if;
      key := 'summary:' || a.id || ':' || yday; chat_id := cfg.chat_id; topic := cfg.results_topic; msg := body;
      return next;
    end if;

    -- Вечернее напоминание: в час напоминания, если тренировка сделана не вся.
    if extract(hour from now_l) >= cfg.remind_hour
       and (st.start_date is null or today >= st.start_date)
       and not exists (select 1 from bot_log l where l.key = 'remind:' || a.id || ':' || today) then
      d := ensure_day(a.id, today);
      if d.status = 'training' then
        c := day_counts(a.id, today);
        if c[1] < c[2] then
          key := 'remind:' || a.id || ':' || today; chat_id := cfg.chat_id; topic := cfg.results_topic;
          msg := coalesce('@' || nullif(a.tg_username, ''), nullif(a.name, ''), 'Атлет') || ', сегодня тренировка: отмечено '
                  || c[1] || ' из ' || c[2] || ' подходов. День закроется в 00:00.';
          return next;
        end if;
      end if;
    end if;

    -- События за последние двое суток, о которых бот ещё не писал.
    for e in
      select 'milestone:' || l.id as k,
             case when l.key = 'milestone:100' then who || ': очков хватает на телефон! Цель достигнута.'
                  else who || ': пройдено ' || split_part(l.key, ':', 2) || '% пути к телефону!' end as m
        from ledger l where l.athlete_id = a.id and l.kind = 'milestone' and l.created_at > now() - interval '2 days'
         and coalesce(l.note, '') not like 'Удалено Тимуром:%'
      union all
      select 'buy:' || p.id, who || case when p.kind = 'allin' then ': куплен день «Всё или ничего» на ' else ': куплен выходной на ' end
             || bot_day_title(p.date) || ', списано ' || p.price || '.'
        from purchases p where p.athlete_id = a.id and p.status = 'active' and p.created_at > now() - interval '2 days'
      union all
      select 'cancel:' || p.id, who || case when p.kind = 'allin' then ': «Всё или ничего» на ' else ': выходной на ' end
             || bot_day_title(p.date) || case when p.kind = 'allin' then ' отменено' else ' отменён' end || ', очки вернулись.'
        from purchases p where p.athlete_id = a.id and p.status = 'cancelled' and p.cancelled_at > now() - interval '2 days'
         and exists (select 1 from bot_log l where l.key = 'buy:' || p.id)
      union all
      select 'sick:' || s.id || ':' || extract(epoch from s.created_at)::bigint,
             who || ' просит больничный на ' || bot_day_title(s.date)
             || coalesce(': «' || s.note || '»', '') || '. Решение — во вкладке «Проверка».'
        from sick_requests s where s.athlete_id = a.id and s.status = 'pending' and s.created_at > now() - interval '2 days'
      union all
      select 'swap:' || s.id || ':' || extract(epoch from s.created_at)::bigint,
             who || ' просит замену на ' || bot_day_title(s.date) || ': '
             || (select string_agg(xe.name || ' → ' || coalesce(xt.name, '?'), ', ' order by xe.position, xe.id)
                   from exercises xe left join exercises xt on xt.id = xe.swap_id where xe.id = any (s.exercise_ids))
             || coalesce(' («' || s.note || '»)', '') || '. Решение — во вкладке «Проверка».'
        from swap_requests s where s.athlete_id = a.id and s.status = 'pending' and s.created_at > now() - interval '2 days'
      union all
      select 'phone:' || l.id, who || ' купил телефон за ' || -l.amount || ' очков! Цель выполнена 🎉'
        from ledger l where l.athlete_id = a.id and l.key = 'phone' and l.amount < 0 and l.created_at > now() - interval '2 days'
      union all
      -- Вес за вчера, записанный до 03:00 уже после итога дня: отдельной строкой (0029).
      select 'bodylate:' || b.athlete_id || ':' || b.date || ':' || extract(epoch from b.updated_at)::bigint,
             who || ': взвешивание за ' || bot_day_title(b.date) || ' — ' || bot_num(b.weight) || ' кг'
             || coalesce(' (' || bot_delta(b.weight - pb.weight) || ')', '')
             || coalesce(' · жир ' || bot_num(b.fat) || '%' || coalesce(' (' || bot_delta(b.fat - pb.fat) || ')', ''), '')
        from body_checks b
        left join lateral (select x.weight, x.fat from body_checks x
                            where x.athlete_id = b.athlete_id and x.date < b.date order by x.date desc limit 1) pb on true
       where b.athlete_id = a.id and b.date = yday
         and exists (select 1 from bot_log l where l.key = 'summary:' || a.id || ':' || b.date and l.sent_at < b.updated_at)
      union all
      select 'idea:' || i.id, who || ' предлагает для магазина: «' || i.text || '»'
        from ideas i where i.athlete_id = a.id and i.created_at > now() - interval '2 days'
    loop
      continue when exists (select 1 from bot_log l where l.key = e.k);
      key := e.k; chat_id := cfg.chat_id; topic := cfg.results_topic; msg := e.m;
      return next;
    end loop;
  end loop;
end $$;

revoke execute on function public.bot_outbox() from public, anon, authenticated;
grant execute on function public.bot_outbox() to service_role;
revoke execute on function public.body_day() from public, anon;
grant execute on function public.body_day(), public.save_body(numeric, numeric) to authenticated;
