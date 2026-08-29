#!/bin/sh
# AC5: Supabase 마이그레이션 자동 실행
# Usage: ./scripts/run-migrations.sh <DATABASE_URL>
#
# Example:
#   ./scripts/run-migrations.sh "postgresql://postgres:password@localhost:5432/sprintable"
#
# story #3219 확장(2026-08-30, 카디르 QA — 페드루 재정의) — 1차 처방(파이프 제거+
# ON_ERROR_STOP+exit 1)만 얹으면 **원버그보다 나쁜 회귀**였다: 이 코퍼스(packages/db/
# supabase/migrations)는 대부분 비멱등이다 — 특히 CREATE POLICY(전수 270건, 129파일)는
# PostgreSQL 자체에 IF NOT EXISTS가 없어, 이미 한 번 적용된 self-host DB가 재시작할
# 때마다 "policy already exists"로 100% 실패한다. 예전(파이프 삼킴) 모델은 그 실패를
# 매번 삼켜 넘어가는 게 사실상 암묵적 멱등화 워크어라운드였다.
#
# 근본 처방 = 마이그 원장(ledger, _sprintable_migration_ledger). 파일명 정렬 순으로
# "아직 원장에 없는 파일만" 실행, 성공하면 그 자리에서 즉시 원장에 기록 — 트랜잭션
# 가능한 파일은 BEGIN/COMMIT으로 감싸 "그 파일 전체 성공 또는 전체 미기록" 원자성을
# 보장한다. 동시 컨테이너 기동 대비 세션 스코프 advisory lock을 배치 시작에 걸고,
# 세션 종료(성공·실패 무엇이든) 시 Postgres가 자동 해제한다(session-scope인 이유는
# 아래 NONTX_ALLOWLIST 참고 — 배치 전체를 하나의 트랜잭션으로 못 감싸므로).
#
# ── 2라운드 카디르 qa:changes(2026-08-30, 페드루 경유) 반영 3건 ──────────────────
#
# ①[HIGH] 시딩↔업그레이드 비구별 — 1라운드의 "원장 空 + stories 有 → 현재 파일 전체
# 시딩"은 **정상 버전업**(구 DB + 신규 SQL 실린 새 이미지)도 똑같이 만족시켜, 신규
# 파일까지 무실행 "적용됨"으로 오기록 → 영구 스키마 누락이 된다. 처방: SEED_CUTOFF를
# "이 PR이 머지되는 시점 기준 최신 파일명"으로 **명시 고정**한다(느슨한 휴리스틱이
# 아니라 상수) — 시딩은 cutoff 이하 파일만 기록하고, cutoff 초과 파일은 시딩 대상에서
# 애초에 제외돼 항상 아래 "실 적용 루프"를 그대로 통과한다(원장에 없으니 진짜 실행).
# ⛔ 잔여 구멍(가드가 못 잡는 것 — feedback_guard_must_declare_what_it_misses) — 이
# cutoff보다 오래된 self-host DB가 cutoff 이전 파일 중 일부를 실제로는 못 받은 채(예:
# 과거 실패가 방치된 채) 여러 릴리스를 건너뛰어 이 이미지로 바로 점프하면, 그 결손은
# 이 설계로 못 닫는다 — 그런 DB는 "pre-ledger 마지막 릴리스를 최소 한 번은 정상 기동해
# 통과시킨 뒤" 이 이미지로 올라오는 것을 전제한다(문서화 요구사항, 자동 검증 불가).
# SEED_CUTOFF는 새 supabase migration 파일이 develop에 머지될 때마다 최신값으로 갱신
# 필요 — 이 상수를 안 올리면 새 파일이 오분류로 시딩될 위험이 있다.
#
# ②[HIGH] INVALID 인덱스 마스킹 — CREATE INDEX CONCURRENTLY가 (락 경합·중복키 등으로)
# 도중 실패하면 Postgres는 롤백하지 않고 그 인덱스를 INVALID 상태로 **남겨둔다**. 같은
# 이름의 IF NOT EXISTS는 "이미 존재"만 보고 다음 재시도에서 조용히 스킵 — 원장엔
# "적용됨"으로 기록되지만 인덱스는 계속 깨진 채다. 처방: NONTX_ALLOWLIST 파일에서
# CREATE INDEX CONCURRENTLY IF NOT EXISTS 대상 인덱스명을 파일 자체에서 grep 추출해,
# 실행 前 INVALID면 DROP INDEX CONCURRENTLY로 선삭제(재빌드 유도) 후 파일 실행, 실행
# 後 여전히 INVALID면 DO 블록으로 RAISE EXCEPTION(ON_ERROR_STOP이 원장기록 前에 정지 —
# 반쪽 성공을 "적용됨"으로 남기지 않는다).
#
# ③[MED] grep 과대 매치 — 옛 처방은 파일 전체에서 문자열 "CONCURRENTLY"가 한 번이라도
# 보이면 그 파일 전체를 무-트랜잭션으로 강등했다. 실측(20260407110000/20260408092000/
# 20260425140000 3개 파일)해보니 REFRESH MATERIALIZED VIEW CONCURRENTLY가 함수 본문
# (BEGIN...END) **안**에만 있어 top-level 실행문이 아니었다 — 그 3개는 트랜잭션 안에서
# 전혀 문제없이 돌아가는데도 불필요하게 원자성을 잃고 있었다. top-level 실행문 판별을
# 범용 파서 없이 안전하게 하긴 어려우므로, 실측으로 확定한 **명시 allowlist**로
# 대체한다(카디르 승인 방식) — 이 목록은 실제로 top-level에서 CREATE INDEX CONCURRENTLY
# 를 쓰는 파일 2개(20260414182300_performance_indexes.sql,
# 20260408133000_hot_query_indexes.sql)뿐이다. ⚠️ 재실측 조건: 이 디렉터리에 top-level
# CONCURRENTLY 구문(CREATE INDEX CONCURRENTLY, DROP INDEX CONCURRENTLY, REINDEX
# CONCURRENTLY 등)을 쓰는 새 파일이 추가되면 이 allowlist도 같이 갱신해야 한다 —
# `grep -B2 -A2 "CONCURRENTLY" <file>`로 BEGIN...END 함수 본문 밖인지 직접 눈으로 확인.

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

# ①의 cutoff — 이 PR(#3219) 머지 시점 기준 packages/db/supabase/migrations의 최신
# 파일명(2026-08-30, `ls packages/db/supabase/migrations/*.sql | sort | tail -1`로
# 실측 확定, origin/develop과 동기 확인 후 고정). 테스트에서만
# SPRINTABLE_MIGRATIONS_SEED_CUTOFF로 오버라이드(합성 파일명 대응).
SEED_CUTOFF="${SPRINTABLE_MIGRATIONS_SEED_CUTOFF:-20260830000000_retire_inbox_items_and_outbox.sql}"

# ③의 allowlist — 위 헤더 코멘트 참고. 테스트에서만
# SPRINTABLE_MIGRATIONS_NONTX_ALLOWLIST로 오버라이드(공백구분 파일명 목록).
NONTX_ALLOWLIST="${SPRINTABLE_MIGRATIONS_NONTX_ALLOWLIST:-20260414182300_performance_indexes.sql 20260408133000_hot_query_indexes.sql}"

is_nontx() {
  name="$1"
  for f in $NONTX_ALLOWLIST; do
    if [ "$f" = "$name" ]; then
      return 0
    fi
  done
  return 1
}

concurrent_index_names() {
  # top-level `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS <name>`의 <name>만
  # 추출 — NONTX_ALLOWLIST 파일에서만 호출되므로 top-level 보장은 allowlist 자체가 짐.
  grep -oE "CREATE (UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS [A-Za-z_][A-Za-z0-9_]*" "$1" | awk '{print $NF}'
}

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
  echo "  \\echo '  🌱 기존 DB 시딩 — cutoff($SEED_CUTOFF) 이하 파일만 실행 없이 already-applied로 기록'"
  past_cutoff=false
  for file in $(ls "$MIGRATIONS_ABS_DIR"/*.sql | sort); do
    name="$(basename "$file")"
    if [ "$past_cutoff" = false ]; then
      esc_name="$(printf '%s' "$name" | sed "s/'/''/g")"
      echo "  INSERT INTO public.$LEDGER_TABLE (filename, seeded) VALUES ('$esc_name', true) ON CONFLICT DO NOTHING;"
      if [ "$name" = "$SEED_CUTOFF" ]; then
        past_cutoff=true
      fi
    fi
  done
  echo "\\endif"
  echo ""
  echo "-- 시딩 여부와 무관하게 항상 실행 — 원장에 없는(=cutoff 초과 신규 포함) 파일만 실 적용 --"
  for file in $(ls "$MIGRATIONS_ABS_DIR"/*.sql | sort); do
    name="$(basename "$file")"
    esc_name="$(printf '%s' "$name" | sed "s/'/''/g")"
    echo "SELECT EXISTS(SELECT 1 FROM public.$LEDGER_TABLE WHERE filename = '$esc_name') AS already_applied \\gset"
    echo "\\if :already_applied"
    echo "  \\echo '  ⏭  SKIP(이미 적용됨): $name'"
    echo "\\else"
    if is_nontx "$name"; then
      for idx in $(concurrent_index_names "$file"); do
        echo "  SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = '$idx' AND NOT i.indisvalid) AS idx_invalid \\gset"
        echo "  \\if :idx_invalid"
        echo "    \\echo '    🔧 INVALID 인덱스 감지, 재생성 위해 선삭제: $idx'"
        echo "    DROP INDEX CONCURRENTLY IF EXISTS $idx;"
        echo "  \\endif"
      done
      echo "  \\i $file"
      for idx in $(concurrent_index_names "$file"); do
        echo "  DO \$\$"
        echo "  BEGIN"
        echo "    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = '$idx' AND NOT i.indisvalid) THEN"
        echo "      RAISE EXCEPTION 'index $idx still INVALID after CONCURRENTLY rebuild — manual intervention required';"
        echo "    END IF;"
        echo "  END \$\$;"
      done
      echo "  INSERT INTO public.$LEDGER_TABLE (filename) VALUES ('$esc_name');"
    else
      echo "  BEGIN;"
      echo "  \\i $file"
      echo "  INSERT INTO public.$LEDGER_TABLE (filename) VALUES ('$esc_name');"
      echo "  COMMIT;"
    fi
    echo "  \\echo '  ✅ 적용됨: $name'"
    echo "\\endif"
  done
  echo "SELECT pg_advisory_unlock($LOCK_EXPR);"
} > "$SQL_SCRIPT"

echo "🔄 Running migrations from $MIGRATIONS_DIR (원장 기반, 미적용분만)..."
if psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$SQL_SCRIPT"; then
  echo "✅ Migrations complete."
else
  echo "❌ Migration run failed — fail-closed 기동 중단"
  exit 1
fi
