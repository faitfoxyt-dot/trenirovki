#!/usr/bin/env bash
# Выполняет в базе новые файлы из supabase/migrations по порядку, каждый — одной транзакцией.
# Что уже выполнено, помнит таблица ops.migrations (схема ops не видна через API сайта).
# Файлы до 0008 включительно Тимур выполнял руками — они только отмечаются, без запуска.
# Строка подключения — только из секрета SUPABASE_DB_URL, в коде её нет.
set -euo pipefail
: "${SUPABASE_DB_URL:?Нет секрета SUPABASE_DB_URL}"
dir="${1:-supabase/migrations}"
baseline="0008"
run() { psql "$SUPABASE_DB_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }

run <<'SQL'
set client_min_messages = warning;
create schema if not exists ops;
revoke all on schema ops from public;
create table if not exists ops.migrations (name text primary key, applied_at timestamptz not null default now());
SQL

for f in "$dir"/*.sql; do
  name="$(basename "$f")"
  if [ -n "$(run -tA -c "select 1 from ops.migrations where name = '$name'")" ]; then continue; fi
  if [[ "${name:0:4}" < "$baseline" || "${name:0:4}" == "$baseline" ]]; then
    run -c "insert into ops.migrations (name) values ('$name')"
    echo "уже был: $name"
    continue
  fi
  echo "выполняю: $name"
  run -1 -f "$f" -c "insert into ops.migrations (name) values ('$name')"
  echo "готово: $name"
done
