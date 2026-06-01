#!/bin/sh
# Cloud Run 마이그레이션 잡 진입점.
# CWD를 /app으로 명시해 alembic.ini script_location 해소.
# 환경 변수: ALEMBIC_DATABASE_URL (Private-IP psycopg2 URL) 필수.
set -eu

if [ -z "${ALEMBIC_DATABASE_URL:-}" ]; then
  echo "ERROR: ALEMBIC_DATABASE_URL is not set." >&2
  echo "Set it to a Private-IP psycopg2 URL: postgresql+psycopg2://user:pass@IP/db" >&2
  exit 1
fi

cd /app
echo "Running: alembic upgrade head"
exec alembic upgrade head
