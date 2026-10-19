-- Трекер тренировок · v3.13: событие дня — звезда на ниточке и мини-игра.
-- Тимур в «Плане» включает событие на сегодня или завтра (игра 'b' — «Генерал приказал»).
-- У атлета на любом экране висит звезда; нажал — мини-игра из 5 ходов, попытка одна:
-- play_event сохраняет счёт после каждого хода, так что перезагрузка страницы не даёт переиграть.
-- Каждый верный ход — +0.1 к множителю: score из 5 → очки дня × (1 + 0.1 × score), 5 из 5 — ×1.5.
-- Множитель ложится поверх всего: очков за подходы (уже с серией) и «Всё или ничего».
-- Бонус пишется одной строкой ledger kind 'event', когда день закончился и всё проверено,
-- и пересчитывается, если Тимур потом поменял проверку. В тестовый период не начисляется.
-- Можно выполнять повторно. Убранное событие не стирается, а помечается active = false.

alter type public.ledger_kind add value if not exists 'event';

create table if not exists public.day_events (
  athlete_id uuid not null references public.profiles (id),
  date       date not null,
  title      text not null default 'Событие дня',
  game       text not null default 'b' check (game in ('a', 'b', 'c')),
  active     boolean not null default true,       -- false — Тимур убрал событие
  score      int check (score between 0 and 5),   -- null — ещё не начал; растёт после каждого хода
  done       boolean not null default false,      -- игра закончена (или закрыта посередине)
  played_at  timestamptz,
  created_at timestamptz not null default now(),
  primary key (athlete_id, date)
);

alter table public.day_events enable row level security;
-- Читает сам атлет и админ; пишут только функции ниже.
do $$ begin
  create policy "свои или админ" on public.day_events
    for select to authenticated using (athlete_id = auth.uid() or public.is_admin());
exception when duplicate_object then null; end $$;

-- ───────────── Функции ─────────────

-- Событие дня для экрана (своё или, админу, любого) и уже начисленный бонус.
create or replace function public.event_day(p_date date, p_athlete uuid default null) returns json
language plpgsql stable security definer set search_path = public as $$
declare
  who uuid := coalesce(p_athlete, auth.uid());
  e   day_events;
begin
  if auth.uid() is null then raise exception 'Нужно войти'; end if;
  if who <> auth.uid() and not is_admin() then raise exception 'Нет доступа'; end if;
  select * into e from day_events where athlete_id = who and date = p_date and active;
  if not found then return null; end if;
  return json_build_object('date', e.date, 'title', e.title, 'game', e.game, 'score', e.score,
    'done', e.done, 'played_at', e.played_at, 'test', is_test_day(e.date),
    'bonus', (select coalesce(sum(l.rating), 0) from ledger l
              where l.athlete_id = who and l.date = e.date and l.kind = 'event'));
end $$;

-- Ход атлета: счёт после хода (только растёт) и закончена ли игра. Одна попытка, только в день события.
create or replace function public.play_event(p_date date, p_score int, p_done boolean) returns json
language plpgsql security definer set search_path = public as $$
declare
  e day_events;
begin
  if auth.uid() is null then raise exception 'Нужно войти'; end if;
  select * into e from day_events where athlete_id = auth.uid() and date = p_date and active for update;
  if not found or p_date <> app_today() then raise exception 'Сегодня события нет'; end if;
  if e.done then raise exception 'Попытка уже была'; end if;
  update day_events
  set score = greatest(coalesce(e.score, 0), least(5, coalesce(p_score, 0))),
      done = coalesce(p_done, false), played_at = coalesce(e.played_at, now())
  where athlete_id = auth.uid() and date = p_date;
  return event_day(p_date);
end $$;

-- Тимур включает событие (на сегодня или позже) или убирает его, пока атлет не начал (p_game = null).
create or replace function public.set_event(p_athlete uuid, p_date date, p_game text, p_title text default null)
returns json
language plpgsql security definer set search_path = public as $$
declare
  e day_events;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  if p_date < app_today() then raise exception 'Событие можно поставить только на сегодня или позже'; end if;
  select * into e from day_events where athlete_id = p_athlete and date = p_date;
  if found and e.active and e.score is not null then raise exception 'Атлет уже начал играть, событие не поменять'; end if;
  if p_game is null then
    update day_events set active = false where athlete_id = p_athlete and date = p_date;
    return null;
  end if;
  insert into day_events (athlete_id, date, game, title)
  values (p_athlete, p_date, p_game, coalesce(nullif(trim(p_title), ''), 'Событие дня'))
  on conflict (athlete_id, date) do update
  set game = excluded.game, title = excluded.title, active = true, score = null, done = false, played_at = null;
  return event_day(p_date, p_athlete);
end $$;

-- Бонус события: (очки за подходы + «Всё или ничего») × 0.1 × score. Пока день идёт или есть
-- непроверенные подходы — бонуса нет; потом строка ledger доводится до нужной суммы.
create or replace function public.event_apply(p_athlete uuid, p_date date) returns void
language plpgsql security definer set search_path = public as $$
declare
  e    day_events;
  base int;
  want int := 0;
  have int;
  delta int;
begin
  if is_test_day(p_date) then return; end if;
  select * into e from day_events where athlete_id = p_athlete and date = p_date and active;
  if found and coalesce(e.score, 0) > 0 and p_date < app_today()
     and not exists (select 1 from set_logs s where s.athlete_id = p_athlete and s.date = p_date and s.review = 'pending') then
    select coalesce(sum(rating), 0) into base from ledger
    where athlete_id = p_athlete and date = p_date and kind in ('set', 'modifier');
    want := greatest(round(base * e.score / 10.0), 0);
  end if;
  select coalesce(sum(rating), 0) into have from ledger
  where athlete_id = p_athlete and date = p_date and kind = 'event';
  delta := want - have;
  if delta = 0 then return; end if;
  insert into ledger (athlete_id, date, kind, amount, rating, note)
  values (p_athlete, p_date, 'event', greatest(delta, -balance_of(p_athlete)), delta,
          case when e.athlete_id is null then 'Событие убрано'
               else case when have <> 0 then 'Пересмотр: ' else '' end
                    || coalesce(e.title, 'Событие') || ': ' || e.score || ' из 5 · очки дня ×'
                    || trim_scale(round(1 + e.score / 10.0, 1)) end);
end $$;

-- settle из 0012 + итог событий после «Всё или ничего» (бонус события считается и от него).
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
  x     ledger;
  ad    date;
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

  for x in select * from ledger l where l.athlete_id = p_athlete and l.kind = 'penalty' and l.amount < 0
             and l.date >= today - 60
             and not exists (select 1 from ledger u where u.athlete_id = p_athlete and u.key = 'unpenalty:' || l.date) loop
    if day_done(p_athlete, x.date) then
      insert into ledger (athlete_id, date, kind, amount, note, key)
      values (p_athlete, x.date, 'refund', -x.amount, 'Штраф снят: день засчитан после проверки', 'unpenalty:' || x.date);
    end if;
  end loop;

  -- «Всё или ничего»: итог дня, когда он закончился и всё проверено (и откат, если покупку отменили).
  for ad in select distinct p.date from purchases p
            where p.athlete_id = p_athlete and p.kind = 'allin' and p.date < today and p.date >= today - 60 loop
    perform allin_apply(p_athlete, ad);
  end loop;

  -- Событие дня: бонус мини-игры поверх всего дня (и откат, если событие убрали).
  for ad in select e.date from day_events e
            where e.athlete_id = p_athlete and e.date < today and e.date >= today - 60
            union
            select l.date from ledger l
            where l.athlete_id = p_athlete and l.kind = 'event' and l.date >= today - 60 loop
    perform event_apply(p_athlete, ad);
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

-- ───────────── Права ─────────────

grant execute on function public.event_day(date, uuid), public.play_event(date, int, boolean),
  public.set_event(uuid, date, text, text) to authenticated;
