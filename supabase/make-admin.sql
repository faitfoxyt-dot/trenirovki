-- Выдать роль админа. Вставить в Supabase → SQL Editor ПОСЛЕ миграции 0001_v1.sql.
-- Замени почту на свою (ту, с которой создан админ-аккаунт) и нажми Run.

update public.profiles
set role = 'admin', name = 'Тимур'
where id = (select id from auth.users where email = 'ТВОЯ_ПОЧТА@gmail.com');

-- Имя атлета в списке у админа (необязательно):
-- update public.profiles set name = 'Тест' where id = (select id from auth.users where email = 'ТВОЯ_ПОЧТА+test@gmail.com');

-- Проверка: должна быть одна строка с role = admin.
select p.role, p.name, u.email from public.profiles p join auth.users u on u.id = p.id order by p.role;
