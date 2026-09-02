#!/bin/sh
# Cloud Run 마이그레이션 잡 진입점(story #f2a27d2a 후속, flip PR).
# backend/scripts/migrate.sh와 달리 precheck 없음 — 이 서비스는 2026-08-31 신설된 단일
# 선형 체인(0001부터)이라 backend가 겪은 EE-stamp/fork/재봉합류 드리프트가 물리적으로
# 존재할 수 없다(과거 head가 하나도 없다). 향후 체인이 갈라지는 사고가 나면 그때 이 파일에
# 동형 precheck를 추가한다 — 지금 미리 짜 넣지 않는다(없는 문제의 방어코드).
# CWD를 /app으로 명시해 alembic.ini script_location 해소.
set -eu

if [ -z "${SUPPORT_GATEWAY_DATABASE_URL:-}" ]; then
  echo "ERROR: SUPPORT_GATEWAY_DATABASE_URL is not set." >&2
  exit 1
fi

cd /app
echo "Running: alembic upgrade head"
exec alembic upgrade head
