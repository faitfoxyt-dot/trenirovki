-- Трекер тренировок · v3.11: замена упражнений по просьбе.
-- У каждого упражнения в каталоге может быть замена (swap_id) со своей целью (swap_target):
-- например, подтягивания → австралийские подтягивания под столом, когда нет турника.
-- Атлет на «Сегодня» отмечает упражнения и просит замену (request_swap), бот сразу пишет Тимуру.
-- Тимур одобряет (decide_swap) — в плане дня эти упражнения становятся заменами: подходов столько же,
-- цель — swap_target, у пункта плана остаётся from = что было. Очки, серия, пропуск и «Всё или ничего»
-- дальше считаются по плану дня как обычно.
-- Заменить можно только сегодняшний день и только упражнение, где ещё не отмечен ни один подход.
-- Можно выполнять повторно.

-- ───────────── Каталог и запросы ─────────────

alter table public.exercises add column if not exists swap_id bigint references public.exercises (id);
alter table public.exercises add column if not exists swap_target int;
do $$ begin
  alter table public.exercises add constraint exercises_swap_check
    check ((swap_target is null or swap_target between 1 and 1000) and swap_id is distinct from id);
exception when duplicate_object then null; end $$;

create table if not exists public.swap_requests (
  id           bigserial primary key,
  athlete_id   uuid not null references public.profiles (id) on delete cascade,
  date         date not null,
  exercise_ids bigint[] not null,          -- что заменить (id из плана дня)
  note         text,
  status       public.request_status not null default 'pending',
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  unique (athlete_id, date)
);

alter table public.swap_requests enable row level security;
-- Читает сам атлет и админ; пишут только функции ниже.
do $$ begin
  create policy "свои или админ" on public.swap_requests
    for select to authenticated using (athlete_id = auth.uid() or public.is_admin());
exception when duplicate_object then null; end $$;

-- ───────────── Функции ─────────────

-- Что заменится в плане дня: [{from: пункт плана, to: {id, name, unit, sets, target_reps}}].
-- p_ids — какие упражнения (null — все, где есть замена). Пропускает уже заменённые и те, где отмечен подход.
-- Видит только свой день или админ.
create or replace function public.swap_items(p_athlete uuid, p_date date, p_ids bigint[]) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'from', x,
           'to', jsonb_build_object('id', t.id, 'name', t.name, 'unit', t.unit, 'sets', (x ->> 'sets')::int,
                                    'target_reps', coalesce(e.swap_target, t.target_reps))) order by o), '[]'::jsonb)
  from days d,
       jsonb_array_elements(coalesce(d.plan, '[]'::jsonb)) with ordinality p(x, o)
  join exercises e on e.id = (x ->> 'id')::bigint
  join exercises t on t.id = e.swap_id and not t.archived
  where d.athlete_id = p_athlete and d.date = p_date
    and (p_athlete = auth.uid() or is_admin())
    and x -> 'from' is null
    and (p_ids is null or e.id = any (p_ids))
    and not exists (select 1 from set_logs s where s.athlete_id = p_athlete and s.date = p_date
                    and s.exercise_id = e.id and s.claimed is not null)
$$;

-- Атлет просит замену на сегодня. Отказанный запрос можно отправить ещё раз.
create or replace function public.request_swap(p_ids bigint[], p_note text) returns public.swap_requests
language plpgsql security definer set search_path = public as $$
declare
  uid   uuid := auth.uid();
  today date := app_today();
  d     days;
  items jsonb;
  res   public.swap_requests;
begin
  if uid is null then raise exception 'Нужно войти'; end if;
  if is_admin() then raise exception 'Замену просит атлет'; end if;
  if p_ids is null or cardinality(p_ids) = 0 then raise exception 'Отметь, что заменить'; end if;
  if today < (select start_date from settings where id = 1) then raise exception 'Старт ещё не наступил'; end if;
  d := ensure_day(uid, today);
  if d.status is distinct from 'training' then raise exception 'Сегодня и так нет тренировки'; end if;
  items := swap_items(uid, today, p_ids);
  if jsonb_array_length(items) < cardinality(p_ids) then
    raise exception 'Заменить можно только упражнение из плана, где ещё не отмечен ни один подход';
  end if;
  insert into swap_requests (athlete_id, date, exercise_ids, note)
  values (uid, today, p_ids, nullif(trim(left(p_note, 200)), ''))
  on conflict (athlete_id, date) do update set
    exercise_ids = excluded.exercise_ids, status = 'pending', note = excluded.note, created_at = now(), decided_at = null
  where swap_requests.status = 'declined'
  returning * into res;
  if res.id is null then raise exception 'Запрос на сегодня уже отправлен'; end if;
  -- Будим бота сразу, чтобы Тимур узнал о запросе, а не ждал :05. Не вышло — бот напишет в :05.
  begin
    perform net.http_post(
      url     := 'https://cszhygtqydszxhcrqnvu.supabase.co/functions/v1/bot',
      headers := '{"Content-Type": "application/json", "apikey": "sb_publishable_YfPspbgiMuySizPLIUQ6eg_guCb3SmI"}'::jsonb,
      body    := '{}'::jsonb);
  exception when others then null;
  end;
  return res;
end $$;

-- Решение Тимура. Одобрение меняет упражнения в плане дня на замены.
create or replace function public.decide_swap(p_id bigint, p_approve boolean) returns public.swap_requests
language plpgsql security definer set search_path = public as $$
declare
  r     public.swap_requests;
  items jsonb;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  select * into r from swap_requests where id = p_id for update;
  if not found then raise exception 'Запрос не найден'; end if;
  if r.status <> 'pending' then raise exception 'Запрос уже решён'; end if;
  if p_approve then
    if r.date < app_today() then raise exception 'День уже закончился'; end if;
    items := swap_items(r.athlete_id, r.date, r.exercise_ids);
    if jsonb_array_length(items) = 0 then raise exception 'Менять уже нечего: подходы отмечены'; end if;
    update days d set plan = (
      select jsonb_agg(coalesce(
               (select i -> 'to' || jsonb_build_object('from', x) from jsonb_array_elements(items) i
                 where (i -> 'from' ->> 'id') = (x ->> 'id')), x) order by o)
      from jsonb_array_elements(d.plan) with ordinality p(x, o)), updated_at = now()
    where d.athlete_id = r.athlete_id and d.date = r.date;
  end if;
  update swap_requests set status = case when p_approve then 'approved' else 'declined' end::public.request_status,
                           decided_at = now()
  where id = p_id returning * into r;
  return r;
end $$;

-- Бот: как в 0012, плюс запрос замены.
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
  public.buy_phone(), public.save_complexes(jsonb, int), public.complex_schedule(uuid, date, date),
  public.buy_allin(date), public.save_allin(jsonb), public.allin_day(date, uuid),
  public.save_body(numeric, numeric), public.delete_body(uuid, date),
  public.request_swap(bigint[], text), public.decide_swap(bigint, boolean)
to authenticated;
grant execute on function public.bot_outbox(), public.bot_mark_sent(text) to service_role;
