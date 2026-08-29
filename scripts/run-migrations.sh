#!/bin/sh
# AC5: Supabase 마이그레이션 자동 실행
# Usage: ./scripts/run-migrations.sh <DATABASE_URL>
#
# Example:
#   ./scripts/run-migrations.sh "postgresql://postgres:password@localhost:5432/sprintable"
#
# story #3219 확장(2026-08-30, 카디르 QA — 페드루 재정의) — 1차 처방(파이프 제거+
# `psql -v ON_ERROR_STOP=1`+즉시 exit 1, 그 자체는 여전히 유효)만 얹으면 **원버그보다
# 나쁜 회귀**였다: 이 코퍼스(packages/db/supabase/migrations)는 대부분 비멱등이다 —
# 특히 `CREATE POLICY`(전수 270건, 129파일)는 PostgreSQL 자체에 `IF NOT EXISTS`가 없어,
# 이미 한 번 적용된 self-host DB가 재시작할 때마다 "policy already exists"로 100%
# 실패한다. 예전(파이프 삼킴) 모델은 그 실패를 매번 삼켜 넘어가는 게 사실상 암묵적
# 멱등화 워크어라운드였다 — fail-closed만 얹으면 **한 번이라도 적용된 self-host DB는
# 재시작 영구 불능**이 된다.
#
# 근본 처방 = 마이그 원장(ledger). 파일명 정렬 순으로 "아직 원장에 없는 파일만" 실행,
# 성공하면 그 자리에서 즉시 원장에 기록 — 트랜잭션 가능한 파일은 BEGIN/COMMIT으로 감싸
# "그 파일 전체 성공 또는 전체 미기록" 원자성을 보장한다. `CREATE INDEX CONCURRENTLY`
# 포함 파일(5개 확인: monthly_agent_usage_view/agent_hitl_pending_status/
# performance_indexes/hot_query_indexes/reward_balances_view)은 트랜잭션 안에서 못
# 돌아 예외 — 그 파일들만 BEGIN/COMMIT 없이 돈다. 이 코퍼스의 CONCURRENTLY는 전부
# `CREATE INDEX CONCURRENTLY IF NOT EXISTS` 또는 `REFRESH MATERIALIZED VIEW
# CONCURRENTLY`라 재시도 자체가 멱등-안전함을 실측 확認(각 파일 grep 대조) — 별도
# skip/제외 로직 불요.
#
# 동시 컨테이너 기동 대비 — 세션 스코프 advisory lock(`pg_advisory_lock`)을 전체 배치
# 시작에 걸고 세션 종료(성공·실패·연결종료 무엇이든) 시 Postgres가 자동 해제한다(표준
# 동작 — 명시 unlock 없이도 안전, 실패 경로에서 ON_ERROR_STOP이 스크립트를 그 자리서
# 멈춰도 세션 종료가 알아서 놓아준다). xact-scope가 아니라 session-scope인 이유: 위
# CONCURRENTLY 파일들 때문에 배치 전체를 하나의 트랜잭션으로 못 감싸므로.
#
# 기존 DB 시딩(급소, 페드루 지적) — 원장 자체가 신설이라, **이미 오래 운영된 self-host
# DB**(이 코퍼스 파일 129개가 예전 모델로 이미 다 적용된 상태)가 원장을 처음 마주치면
# "원장 부재 + 코어 테이블 실재" 조건으로 판별해 **현재 존재하는 파일 전부를 실행 없이
# 이미 적용됨으로 시딩**한다 — 안 그러면 이미 적용된 CREATE POLICY 270건이 전부 다시
# 실행되며 그대로 터진다. 코어 테이블 센티널은 `public.stories`(`users`는 이 코퍼스
# 어디서도 CREATE 안 됨 — grep 0건으로 기각. `stories`는 이 디렉터리의 가장 이른 파일
# 028_stories_meeting_ref.sql이 이미 있다고 전제하는, 001~027 베이스라인이 만드는
# 테이블). 신선 DB(그 테이블 자체가 없음)는 시딩 없이 전량 정상 실행 — 내려가며 이
# 코퍼스 파일들이 stories를 포함해 처음부터 다 만든다.

set -eu

DB_URL="${1:-$DATABASE_URL}"

if [ -z "$DB_URL" ]; then
  echo "❌ Usage: ./scripts/run-migrations.sh <DATABASE_URL>"
  echo "   Or set DATABASE_URL environment variable"
  exit 1
fi

# Docker 내에서는 /migrations, 호스트에서는 packages/db/supabase/migrations
if [ -d "/app/migrations" ]; then
  MIGRATIONS_DIR="/app/migrations"
else
  MIGRATIONS_DIR="packages/db/supabase/migrations"
fi

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "❌ Migrations directory not found: $MIGRATIONS_DIR"
  exit 1
fi

MIGRATIONS_ABS_DIR="$(cd "$MIGRATIONS_DIR" && pwd)"
LEDGER_TABLE="_sprintable_migration_ledger"
# supabase CLI 자체 원장(public.supabase_migrations)과 이름 충돌 회피.
LOCK_EXPR="hashtext('sprintable_migrations_ledger_lock')"
SENTINEL_TABLE="public.stories"

SQL_SCRIPT="$(mktemp)"
trap 'rm -f "$SQL_SCRIPT"' EXIT INT TERM

{
  echo "SELECT pg_advisory_lock($LOCK_EXPR);"
  echo "CREATE TABLE IF NOT EXISTS public.$LEDGER_TABLE ("
  echo "  filename text PRIMARY KEY,"
  echo "  applied_at timestamptz NOT NULL DEFAULT now(),"
  echo "  seeded boolean NOT NULL DEFAULT false"
  echo ");"
  echo "SELECT NOT EXISTS(SELECT 1 FROM public.$LEDGER_TABLE)"
  echo "       AND to_regclass('$SENTINEL_TABLE') IS NOT NULL AS needs_seed \\gset"
  echo "\\if :needs_seed"
  echo "  \\echo '  🌱 기존 DB 시딩 — 현재 파일 전체를 실행 없이 already-applied로 기록'"
  for file in $(ls "$MIGRATIONS_ABS_DIR"/*.sql | sort); do
    name="$(basename "$file")"
    esc_name="$(printf '%s' "$name" | sed "s/'/''/g")"
    echo "  INSERT INTO public.$LEDGER_TABLE (filename, seeded) VALUES ('$esc_name', true) ON CONFLICT DO NOTHING;"
  done
  echo "\\else"
  for file in $(ls "$MIGRATIONS_ABS_DIR"/*.sql | sort); do
    name="$(basename "$file")"
    esc_name="$(printf '%s' "$name" | sed "s/'/''/g")"
    echo "  SELECT EXISTS(SELECT 1 FROM public.$LEDGER_TABLE WHERE filename = '$esc_name') AS already_applied \\gset"
    echo "  \\if :already_applied"
    echo "    \\echo '  ⏭  SKIP(이미 적용됨): $name'"
    echo "  \\else"
    if grep -q "CONCURRENTLY" "$file"; then
      # CONCURRENTLY는 트랜잭션 안에서 실행 불가 — BEGIN/COMMIT 안 씌운다(이 코퍼스의
      # CONCURRENTLY 전부 IF NOT EXISTS/REFRESH ... CONCURRENTLY라 재시도 자체가 안전).
      echo "    \\i $file"
      echo "    INSERT INTO public.$LEDGER_TABLE (filename) VALUES ('$esc_name');"
    else
      echo "    BEGIN;"
      echo "    \\i $file"
      echo "    INSERT INTO public.$LEDGER_TABLE (filename) VALUES ('$esc_name');"
      echo "    COMMIT;"
    fi
    echo "    \\echo '  ✅ 적용됨: $name'"
    echo "  \\endif"
  done
  echo "\\endif"
  echo "SELECT pg_advisory_unlock($LOCK_EXPR);"
} > "$SQL_SCRIPT"

echo "🔄 Running migrations from $MIGRATIONS_DIR (원장 기반, 미적용분만)..."
if psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$SQL_SCRIPT"; then
  echo "✅ Migrations complete."
else
  echo "❌ Migration run failed — fail-closed 기동 중단"
  exit 1
fi
