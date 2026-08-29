#!/usr/bin/env bash
# story #3219(2026-08-30, 카디르 3618 QA 4라운드 실측) — run-migrations.sh의 옛 파이프
# 기반 실패 감지(`psql ... | grep -v "^$" | head -5; if [ $? -ne 0 ]`)가 실제로 psql의
# 종료코드를 못 보고(파이프 마지막 명령은 head, 거의 항상 성공) SQL이 깨져도 "⚠️ Warning"
# 한 줄만 찍고 다음 파일로 계속 진행했다 — self-host 컨테이너가 부분 적용된 스키마로
# 조용히 정상처럼 뜨는 신뢰 결함. 진짜 로컬 Postgres(backend/scripts/disposable_pg.sh
# 재사용, story #3199)에 SQL 파일 3개(성공·고의 파손·성공)를 먹여 실행 결과로 고정한다 —
# narrative가 아니라 실제 psql 호출·실제 종료코드로.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/run-migrations.sh"
DISPOSABLE_PG="$SCRIPT_DIR/../backend/scripts/disposable_pg.sh"
PORT=55501

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAIL=0
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ok   $label"
  else
    echo "  FAIL $label — expected [$expected], got [$actual]"
    FAIL=1
  fi
}

# ── 합성 마이그레이션 디렉터리: 001(성공) → 002(고의 파손) → 003(성공, 도달하면 안 됨) ──
SANDBOX="$WORK/sandbox"
mkdir -p "$SANDBOX/packages/db/supabase/migrations" "$SANDBOX/scripts"
cp "$SCRIPT" "$SANDBOX/scripts/run-migrations.sh"
cat > "$SANDBOX/packages/db/supabase/migrations/001_ok.sql" <<'EOF'
CREATE TABLE public.file_one_marker (id int);
EOF
cat > "$SANDBOX/packages/db/supabase/migrations/002_broken.sql" <<'EOF'
THIS IS NOT VALID SQL AT ALL;
EOF
cat > "$SANDBOX/packages/db/supabase/migrations/003_ok.sql" <<'EOF'
CREATE TABLE public.file_three_marker (id int);
EOF

echo "== 실 disposable PG 기동(story #3199 리그 재사용, 세션 모드) =="
DATA_DIR="$WORK/pgdata"
PG_BIN="$(dirname "$(command -v postgres 2>/dev/null || echo /opt/homebrew/opt/postgresql@16/bin/postgres)")"
export PATH="$PG_BIN:$PATH"

# 세션 모드(원샷 아님) — 이 테스트는 여러 psql/스크립트 호출이 필요해 같은 인스턴스를
# 계속 붙들고, 끝에 직접 SIGTERM으로 정지한다(#3199 배경 sleep+wait라 즉시 반응).
"$DISPOSABLE_PG" "$DATA_DIR" "$PORT" &
PG_SESSION_PID=$!
for _ in $(seq 1 30); do
  pg_isready -h 127.0.0.1 -p "$PORT" >/dev/null 2>&1 && break
  sleep 0.3
done

DB_URL="postgresql://postgres@127.0.0.1:$PORT/postgres"
createdb -h 127.0.0.1 -p "$PORT" -U postgres fault_test

echo
echo "== 고의 파손 파일 포함 실행 — fail-closed 실증 =="
cd "$SANDBOX"
if OUT="$(sh scripts/run-migrations.sh "postgresql://postgres@127.0.0.1:$PORT/fault_test" 2>&1)"; then
  EXIT_CODE=0
else
  EXIT_CODE=$?
fi
echo "$OUT"
echo "  (script exit=$EXIT_CODE)"

assert_eq "고의 파손 시 스크립트 exit code != 0" "1" "$EXIT_CODE"

ONE_COUNT="$(psql -h 127.0.0.1 -p "$PORT" -U postgres -d fault_test -tAc "SELECT COUNT(*) FROM file_one_marker" 2>/dev/null || echo "MISSING")"
assert_eq "001(고장 이전) 파일은 정상 적용됨" "0" "$ONE_COUNT"

THREE_EXISTS="$(psql -h 127.0.0.1 -p "$PORT" -U postgres -d fault_test -tAc "SELECT to_regclass('public.file_three_marker') IS NOT NULL" 2>/dev/null || echo "ERROR")"
assert_eq "003(고장 이후) 파일은 절대 적용 안 됨(halt 실증)" "f" "$THREE_EXISTS"

echo
echo "== 정상 경로(고장 없음) — 무회귀 =="
createdb -h 127.0.0.1 -p "$PORT" -U postgres good_test
SANDBOX_GOOD="$WORK/sandbox_good"
mkdir -p "$SANDBOX_GOOD/packages/db/supabase/migrations" "$SANDBOX_GOOD/scripts"
cp "$SCRIPT" "$SANDBOX_GOOD/scripts/run-migrations.sh"
cp "$SANDBOX/packages/db/supabase/migrations/001_ok.sql" "$SANDBOX_GOOD/packages/db/supabase/migrations/"
cp "$SANDBOX/packages/db/supabase/migrations/003_ok.sql" "$SANDBOX_GOOD/packages/db/supabase/migrations/"
cd "$SANDBOX_GOOD"
if GOOD_OUT="$(sh scripts/run-migrations.sh "postgresql://postgres@127.0.0.1:$PORT/good_test" 2>&1)"; then
  GOOD_EXIT=0
else
  GOOD_EXIT=$?
fi
echo "$GOOD_OUT"
assert_eq "고장 없는 정상 경로는 exit=0" "0" "$GOOD_EXIT"

kill -TERM "$PG_SESSION_PID" 2>/dev/null || true
wait "$PG_SESSION_PID" 2>/dev/null || true

echo
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASS"
  exit 0
else
  echo "FAILURES ABOVE"
  exit 1
fi
