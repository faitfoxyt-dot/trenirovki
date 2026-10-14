-- Трекер тренировок · v1: роли, план, дни, подходы, утро, проверка (без очков).
-- Применять один раз целиком в Supabase → SQL Editor.
-- Время только серверное: «сегодня» считается по зоне Europe/Tallinn.

-- ───────────── Типы ─────────────

create type public.user_role as enum ('admin', 'athlete');
create type public.day_status as enum ('training', 'rest', 'bought', 'sick', 'busy');
create type public.review_status as enum ('pending', 'accepted', 'corrected', 'rejected');
create type public.muscle_state as enum ('ok', 'sore', 'pain');

-- ───────────── Таблицы ─────────────

create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  role       public.user_role not null default 'athlete',
  name       text not null default '',
  created_at timestamptz not null default now()
);

-- Одна строка с правилами. Поля очков заполняются после калибровки (v3).
create table public.settings (
  id                  int primary key default 1 check (id = 1),
  start_date          date,                       -- старт калибровки; до него дни не считаются
  calibration         boolean not null default true,
  grace_hours         int not null default 3 check (grace_hours between 0 and 6),
  points_per_rep      numeric,
  points_per_set      numeric,
  streak              jsonb not null default '{}'::jsonb,
  bonuses             jsonb not null default '{}'::jsonb,
  miss_penalty        int,
  rest_day_price      int,
  purchase_limit_week int,
  phone_price         int,
  updated_at          timestamptz not null default now()
);
insert into public.settings (id) values (1);

-- Шаблон недели: 1 = понедельник … 7 = воскресенье (ISO).
create table public.week_template (
  dow    smallint primary key check (dow between 1 and 7),
  status public.day_status check (status in ('training', 'rest', 'busy'))
);
insert into public.week_template (dow, status)
select g, null from generate_series(1, 7) g;

create table public.exercises (
  id          bigint generated always as identity primary key,
  name        text not null check (length(trim(name)) > 0),
  sets        int not null default 3 check (sets between 1 and 10),
  target_reps int check (target_reps is null or target_reps between 1 and 1000),  -- null = калибровка
  position    int not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- День атлета. plan — снимок комплекса на этот день: [{id, name, sets, target_reps}].
create table public.days (
  athlete_id uuid not null references public.profiles (id) on delete cascade,
  date       date not null,
  status     public.day_status,
  plan       jsonb,
  updated_at timestamptz not null default now(),
  primary key (athlete_id, date)
);

create table public.set_logs (
  id          bigint generated always as identity primary key,
  athlete_id  uuid not null references public.profiles (id) on delete cascade,
  date        date not null,
  exercise_id bigint not null references public.exercises (id),
  set_no      int not null check (set_no between 1 and 10),
  claimed     int check (claimed is null or claimed between 0 and 1000),
  has_video   boolean not null default false,
  review      public.review_status not null default 'pending',
  confirmed   int check (confirmed is null or confirmed between 0 and 1000),
  comment     text,
  points      int,                                -- v3
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  reviewed_at timestamptz,
  unique (athlete_id, date, exercise_id, set_no)
);
create index set_logs_pending on public.set_logs (date) where review = 'pending';

create table public.morning_checks (
  athlete_id uuid not null references public.profiles (id) on delete cascade,
  date       date not null,
  muscles    public.muscle_state,
  energy     int check (energy is null or energy between 1 and 5),
  note       text check (note is null or length(note) <= 500),
  updated_at timestamptz not null default now(),
  primary key (athlete_id, date)
);

-- ───────────── Время ─────────────

create function public.app_now() returns timestamp
language sql stable as $$ select now() at time zone 'Europe/Tallinn' $$;

create function public.app_today() returns date
language sql stable as $$ select (now() at time zone 'Europe/Tallinn')::date $$;

-- Что сейчас по серверу: дата, время и идёт ли окно дозаливки за вчера.
create function public.app_clock() returns json
language sql stable as $$
  select json_build_object(
    'today', public.app_today(),
    'time',  to_char(public.app_now(), 'HH24:MI'),
    'grace', extract(hour from public.app_now()) < (select grace_hours from public.settings where id = 1)
  )
$$;

-- ───────────── Роли ─────────────

create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin')
$$;

-- Профиль создаётся сам при добавлении пользователя в панели Supabase.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, name) values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- Пользователи, созданные до этой миграции.
insert into public.profiles (id, name)
select id, split_part(email, '@', 1) from auth.users
on conflict (id) do nothing;

-- ───────────── Логика дня ─────────────

create function public.current_plan() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'name', name, 'sets', sets, 'target_reps', target_reps)
         order by position, id), '[]'::jsonb)
  from exercises where active
$$;

-- Строка дня: берёт статус из шаблона недели и фиксирует комплекс,
-- когда день наступил. Будущие дни не создаёт.
create function public.ensure_day(p_athlete uuid, p_date date) returns public.days
language plpgsql security definer set search_path = public as $$
declare
  d public.days;
begin
  select * into d from days where athlete_id = p_athlete and date = p_date;
  if not found then
    if p_date > app_today() then
      return null;
    end if;
    insert into days (athlete_id, date, status)
    values (p_athlete, p_date,
            (select status from week_template where dow = extract(isodow from p_date)))
    returning * into d;
  end if;
  if d.status = 'training' and d.plan is null and p_date <= app_today() then
    update days set plan = current_plan(), updated_at = now()
    where athlete_id = p_athlete and date = p_date
    returning * into d;
  end if;
  return d;
end $$;

-- Открыть день: атлет — свой, админ — любого атлета.
create function public.open_day(p_date date, p_athlete uuid default null) returns public.days
language plpgsql security definer set search_path = public as $$
declare
  who uuid := coalesce(p_athlete, auth.uid());
begin
  if auth.uid() is null then raise exception 'Нужно войти'; end if;
  if who <> auth.uid() and not is_admin() then raise exception 'Нет доступа'; end if;
  return ensure_day(who, p_date);
end $$;

-- Отметка подхода. Сегодня можно всё; во время дозаливки за вчера — только видео.
create function public.log_set(
  p_date date, p_exercise_id bigint, p_set_no int, p_claimed int, p_has_video boolean
) returns public.set_logs
language plpgsql security definer set search_path = public as $$
declare
  uid   uuid := auth.uid();
  today date := app_today();
  st    public.settings;
  d     public.days;
  ex    jsonb;
  prev  public.set_logs;
  res   public.set_logs;
  grace boolean;
begin
  if uid is null then raise exception 'Нужно войти'; end if;
  select * into st from settings where id = 1;

  if p_date = today then
    grace := false;
  elsif p_date = today - 1 and extract(hour from app_now()) < st.grace_hours then
    grace := true;
  else
    raise exception 'День закрыт';
  end if;

  if st.start_date is not null and p_date < st.start_date then
    raise exception 'Калибровка ещё не началась';
  end if;

  d := ensure_day(uid, p_date);
  if d.status is distinct from 'training' then
    raise exception 'В этот день нет тренировки';
  end if;

  select value into ex from jsonb_array_elements(d.plan) where (value ->> 'id')::bigint = p_exercise_id;
  if ex is null then raise exception 'Этого упражнения нет в плане дня'; end if;
  if p_set_no < 1 or p_set_no > (ex ->> 'sets')::int then raise exception 'Лишний подход'; end if;

  select * into prev from set_logs
  where athlete_id = uid and date = p_date and exercise_id = p_exercise_id and set_no = p_set_no
  for update;

  if grace then
    if not found then raise exception 'День закрыт, можно только отметить видео'; end if;
    update set_logs set has_video = p_has_video, updated_at = now()
    where id = prev.id returning * into res;
    return res;
  end if;

  if not found then
    insert into set_logs (athlete_id, date, exercise_id, set_no, claimed, has_video)
    values (uid, p_date, p_exercise_id, p_set_no, p_claimed, p_has_video)
    returning * into res;
  else
    update set_logs set
      claimed     = p_claimed,
      has_video   = p_has_video,
      -- Атлет поменял число после проверки — подход снова ждёт решения.
      review      = case when prev.claimed is distinct from p_claimed then 'pending' else prev.review end,
      confirmed   = case when prev.claimed is distinct from p_claimed then null else prev.confirmed end,
      reviewed_at = case when prev.claimed is distinct from p_claimed then null else prev.reviewed_at end,
      updated_at  = now()
    where id = prev.id returning * into res;
  end if;
  return res;
end $$;

-- Утренний опрос: только за сегодня. null в поле — оставить как было.
create function public.save_morning(p_muscles public.muscle_state, p_energy int, p_note text)
returns public.morning_checks
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  res public.morning_checks;
begin
  if uid is null then raise exception 'Нужно войти'; end if;
  insert into morning_checks (athlete_id, date, muscles, energy, note)
  values (uid, app_today(), p_muscles, p_energy, nullif(trim(p_note), ''))
  on conflict (athlete_id, date) do update set
    muscles    = coalesce(excluded.muscles, morning_checks.muscles),
    energy     = coalesce(excluded.energy, morning_checks.energy),
    note       = case when p_note is null then morning_checks.note else excluded.note end,
    updated_at = now()
  returning * into res;
  return res;
end $$;

-- Решение по подходу. Очки появятся в v3, здесь же.
create function public.review_set(
  p_id bigint, p_decision public.review_status, p_confirmed int, p_comment text
) returns public.set_logs
language plpgsql security definer set search_path = public as $$
declare
  prev public.set_logs;
  res public.set_logs;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  select * into prev from set_logs where id = p_id for update;
  if not found then raise exception 'Подход не найден'; end if;
  if p_decision = 'corrected' and p_confirmed is null then
    raise exception 'Укажи подтверждённое число';
  end if;
  update set_logs set
    review      = p_decision,
    confirmed   = case p_decision
                    when 'accepted'  then prev.claimed
                    when 'corrected' then p_confirmed
                    when 'rejected'  then 0
                    else null end,
    comment     = nullif(trim(p_comment), ''),
    reviewed_at = case when p_decision = 'pending' then null else now() end,
    updated_at  = now()
  where id = p_id returning * into res;
  return res;
end $$;

-- Статус одного дня от админа (тренировка, выходной, занят).
create function public.set_day_status(p_athlete uuid, p_date date, p_status public.day_status)
returns public.days
language plpgsql security definer set search_path = public as $$
declare
  res public.days;
begin
  if not is_admin() then raise exception 'Только для админа'; end if;
  insert into days (athlete_id, date, status) values (p_athlete, p_date, p_status)
  on conflict (athlete_id, date) do update set status = excluded.status, updated_at = now()
  returning * into res;
  if p_status = 'training' and res.plan is null and p_date <= app_today() then
    update days set plan = current_plan() where athlete_id = p_athlete and date = p_date
    returning * into res;
  end if;
  return res;
end $$;

-- ───────────── Права (RLS) ─────────────

alter table public.profiles       enable row level security;
alter table public.settings       enable row level security;
alter table public.week_template  enable row level security;
alter table public.exercises      enable row level security;
alter table public.days           enable row level security;
alter table public.set_logs       enable row level security;
alter table public.morning_checks enable row level security;

create policy "свой профиль или админ" on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_admin());
create policy "админ меняет профили" on public.profiles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "читают все вошедшие" on public.settings
  for select to authenticated using (true);
create policy "меняет админ" on public.settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "читают все вошедшие" on public.week_template
  for select to authenticated using (true);
create policy "меняет админ" on public.week_template
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "читают все вошедшие" on public.exercises
  for select to authenticated using (true);
create policy "админ добавляет" on public.exercises
  for insert to authenticated with check (public.is_admin());
create policy "админ меняет" on public.exercises
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Дни, подходы и утро атлет только читает: пишет он через функции выше.
create policy "свои или админ" on public.days
  for select to authenticated using (athlete_id = auth.uid() or public.is_admin());
create policy "свои или админ" on public.set_logs
  for select to authenticated using (athlete_id = auth.uid() or public.is_admin());
create policy "свои или админ" on public.morning_checks
  for select to authenticated using (athlete_id = auth.uid() or public.is_admin());

-- Без входа — ничего.
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from anon, authenticated, public;
grant execute on function
  public.app_now(), public.app_today(), public.app_clock(), public.is_admin(), public.open_day(date, uuid),
  public.log_set(date, bigint, int, int, boolean),
  public.save_morning(public.muscle_state, int, text),
  public.review_set(bigint, public.review_status, int, text),
  public.set_day_status(uuid, date, public.day_status)
to authenticated;
