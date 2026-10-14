-- Трекер тренировок · v3.3: очки вручную как угодно и покупка телефона.
-- Тимур добавляет, снимает или выставляет баланс ровно, сам решает, менять ли рейтинг.
-- Атлет покупает телефон кнопкой, когда очков хватает; бот пишет об этом в «Итоги».
-- Применять один раз целиком в Supabase → SQL Editor и сразу смёржить PR v3.3.

-- ───────────── Очки вручную ─────────────

-- p_rating: менять ли рейтинг вместе с балансом. Баланс ниже нуля не уходит, рейтинг тоже.
drop function public.grant_points(uuid, int, text);
create function public.grant_points(p_athlete uuid, p_amount int, p_note text, p_rating boolean) returns public.ledger
language plpgsql security definer set search_path = public as $$
declare
  res public.ledger;
  amt int;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  if coalesce(p_amount, 0) = 0 then raise exception 'Укажи число очков'; end if;
  if length(trim(coalesce(p_note, ''))) = 0 then raise exception 'Напиши причину'; end if;
  perform lock_athlete(p_athlete);
  amt := greatest(p_amount, -balance_of(p_athlete));
  insert into ledger (athlete_id, date, kind, amount, rating, note)
  values (p_athlete, app_today(), 'manual', amt,
          case when p_rating then greatest(p_amount, -rating_of(p_athlete)) else 0 end,
          'Тимур: ' || trim(p_note))
  returning * into res;
  perform settle(p_athlete);
  return res;
end $$;

-- ───────────── Покупка телефона ─────────────

-- Один раз: списывает цену телефона с баланса. Рейтинг не трогает.
create function public.buy_phone() returns public.ledger
language plpgsql security definer set search_path = public as $$
declare
  me    uuid := auth.uid();
  price int := (rules_for(app_today())).phone_price;
  bal   int;
  res   public.ledger;
begin
  if me is null then raise exception 'Нужно войти'; end if;
  if (select role from profiles where id = me) is distinct from 'athlete' then
    raise exception 'Телефон покупает атлет';
  end if;
  if price is null then raise exception 'Цену телефона Тимур ещё не поставил'; end if;
  perform lock_athlete(me);
  if exists (select 1 from ledger where athlete_id = me and key = 'phone') then
    raise exception 'Телефон уже куплен';
  end if;
  bal := balance_of(me);
  if bal < price then raise exception 'Не хватает очков: нужно %, на балансе %', price, bal; end if;
  insert into ledger (athlete_id, date, kind, amount, rating, note, key)
  values (me, app_today(), 'purchase', -price, 0, 'Покупка: телефон', 'phone')
  returning * into res;
  return res;
end $$;

-- Счёт атлета: плюс дата покупки телефона.
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
    'phone_bought', (select date from ledger where athlete_id = who and key = 'phone'),
    'theory', case when is_admin() then (select coalesce(sum(points), 0) from theory_points where athlete_id = who) end);
end $$;

-- Удалить запись очков: покупку телефона — целиком (очки вернутся, купить можно снова),
-- остальные разовые записи — обнулить, иначе штраф за тот же день начислился бы снова.
create or replace function public.delete_ledger(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  x public.ledger;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  select * into x from ledger where id = p_id;
  if not found then raise exception 'Запись не найдена'; end if;
  perform lock_athlete(x.athlete_id);
  if x.key is not null and x.key <> 'phone' then
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

-- ───────────── Бот ─────────────
-- Как в v3, плюс сообщение о покупке телефона; обнулённые Тимуром вехи не объявляются.

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
  planned int;
  done    int;
  pending int;
  body    text;
  pen     ledger;
  e       record;
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
      select count(*) into pending from set_logs s
      where s.athlete_id = a.id and s.review = 'pending' and s.claimed is not null;
      if pending > 0 then
        body := body || E'\n' || 'Ждут проверки Тимура: ' || pending;
      end if;
      key := 'summary:' || a.id || ':' || yday; chat_id := cfg.chat_id; topic := cfg.results_topic; msg := body;
      return next;
    end if;

    -- Вечернее напоминание: в час напоминания, если тренировка заполнена не вся.
    if extract(hour from now_l) >= cfg.remind_hour
       and (st.start_date is null or today >= st.start_date)
       and not exists (select 1 from bot_log l where l.key = 'remind:' || a.id || ':' || today) then
      d := ensure_day(a.id, today);
      if d.status = 'training' then
        select coalesce(sum((value ->> 'sets')::int), 0) into planned from jsonb_array_elements(coalesce(d.plan, '[]'::jsonb));
        select count(*) into done from set_logs s
        where s.athlete_id = a.id and s.date = today and s.claimed is not null;
        if done < planned then
          key := 'remind:' || a.id || ':' || today; chat_id := cfg.chat_id; topic := cfg.results_topic;
          msg := coalesce('@' || nullif(a.tg_username, ''), nullif(a.name, ''), 'Атлет') || ', сегодня тренировка: отмечено '
                  || done || ' из ' || planned || ' подходов. День закроется в 00:00.';
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
      select 'buy:' || p.id, who || ': куплен выходной на ' || bot_day_title(p.date) || ', списано ' || p.price || '.'
        from purchases p where p.athlete_id = a.id and p.status = 'active' and p.created_at > now() - interval '2 days'
      union all
      select 'cancel:' || p.id, who || ': выходной на ' || bot_day_title(p.date) || ' отменён, очки вернулись.'
        from purchases p where p.athlete_id = a.id and p.status = 'cancelled' and p.cancelled_at > now() - interval '2 days'
         and exists (select 1 from bot_log l where l.key = 'buy:' || p.id)
      union all
      select 'sick:' || s.id || ':' || extract(epoch from s.created_at)::bigint,
             who || ' просит больничный на ' || bot_day_title(s.date)
             || coalesce(': «' || s.note || '»', '') || '. Решение — во вкладке «Проверка».'
        from sick_requests s where s.athlete_id = a.id and s.status = 'pending' and s.created_at > now() - interval '2 days'
      union all
      select 'phone:' || l.id, who || ' купил телефон за ' || -l.amount || ' очков! Цель выполнена 🎉'
        from ledger l where l.athlete_id = a.id and l.key = 'phone' and l.amount < 0 and l.created_at > now() - interval '2 days'
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
