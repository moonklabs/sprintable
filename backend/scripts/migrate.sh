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

# story bda4beac: pricing(ee) 마이그(0146/0147)가 core 체인(0145→0148→0149+)과 분기된
# 별도 head라 이미지에 그 파일이 없는 환경(main/prod)에선 head가 1개, 있는 환경(develop/ee
# 빌드)에선 2개다 — `heads`(복수)는 두 경우 모두 안전(단일-head 환경에서도 그대로 동작).
cd /app
echo "Running: alembic upgrade heads"
exec alembic upgrade heads
