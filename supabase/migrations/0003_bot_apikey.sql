-- v2: Supabase пускает к функциям только запросы с ключом, даже без проверки JWT.
-- Передаём публичный publishable key (он и так есть в коде сайта).
-- cron.schedule с тем же именем заменяет задание из 0002_bot.sql.

select cron.schedule(
  'trenirovki-bot',
  '5 * * * *',
  $$ select net.http_post(
       url     := 'https://cszhygtqydszxhcrqnvu.supabase.co/functions/v1/bot',
       headers := '{"Content-Type": "application/json", "apikey": "sb_publishable_YfPspbgiMuySizPLIUQ6eg_guCb3SmI"}'::jsonb,
       body    := '{}'::jsonb
     ) $$
);

-- Разовый запуск сразу, не дожидаясь :05. Ответ функции появится в net._http_response.
select net.http_post(
  url     := 'https://cszhygtqydszxhcrqnvu.supabase.co/functions/v1/bot',
  headers := '{"Content-Type": "application/json", "apikey": "sb_publishable_YfPspbgiMuySizPLIUQ6eg_guCb3SmI"}'::jsonb,
  body    := '{}'::jsonb
);
