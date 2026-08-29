#!/usr/bin/env bash
# story #3219(2026-08-30, 페드루 마이그 원장 리디자인 지시) — run-migrations.sh를 단순
# ON_ERROR_STOP+exit 1(카디르 3618 QA 4라운드 처방)에서 원장(ledger) 기반으로 재설계.
# 이유: 이 코퍼스(packages/db/supabase/migrations)의 CREATE POLICY 270건은 구조적으로
# 비멱등(IF NOT EXISTS 문법 자체가 없음) — fail-closed만 얹으면 이미 한 번 적용된
# self-host DB가 재시작 영구 불능이 되는 회귀였다(카디르 재실측). 아래 6개 시나리오를
# 실 로컬 Postgres(backend/scripts/disposable_pg.sh 재사용, story #3199)로 고정한다 —
# narrative가 아니라 실제 psql 호출·실제 종료코드·실제 원장 row로.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/run-migrations.sh"
DISPOSABLE_PG="$SCRIPT_DIR/../backend/scripts/disposable_pg.sh"
PORT=55502

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

sql1() { psql -h 127.0.0.1 -p "$PORT" -U postgres -d "$1" -tAc "$2" 2>/dev/null; }

mk_sandbox() {
  # $1 = sandbox dir name (under $WORK)
  local dir="$WORK/$1"
  mkdir -p "$dir/packages/db/supabase/migrations" "$dir/scripts"
  cp "$SCRIPT" "$dir/scripts/run-migrations.sh"
  echo "$dir"
}

run_script() {
  # $1 = sandbox dir, $2 = db name → sets $EXIT_CODE, $OUT
  ( cd "$1" && sh scripts/run-migrations.sh "postgresql://postgres@127.0.0.1:$PORT/$2" ) >"$WORK/last_out.txt" 2>&1
  EXIT_CODE=$?
  OUT="$(cat "$WORK/last_out.txt")"
}

echo "== 실 disposable PG 기동(story #3199 리그 재사용, 세션 모드) =="
DATA_DIR="$WORK/pgdata"
PG_BIN="$(dirname "$(command -v postgres 2>/dev/null || echo /opt/homebrew/opt/postgresql@16/bin/postgres)")"
export PATH="$PG_BIN:$PATH"

"$DISPOSABLE_PG" "$DATA_DIR" "$PORT" &
PG_SESSION_PID=$!
for _ in $(seq 1 30); do
  pg_isready -h 127.0.0.1 -p "$PORT" >/dev/null 2>&1 && break
  sleep 0.3
done

# ── 시나리오 1: 신선 설치 — stories 부재, 원장 부재 → 시딩 없이 전량 정상 실행 ──
echo
echo "== [1] 신선 설치 =="
createdb -h 127.0.0.1 -p "$PORT" -U postgres db_fresh
SB1="$(mk_sandbox sb_fresh)"
cat > "$SB1/packages/db/supabase/migrations/001_ok.sql" <<'EOF'
CREATE TABLE public.fresh_marker_one (id int);
EOF
cat > "$SB1/packages/db/supabase/migrations/002_ok.sql" <<'EOF'
CREATE TABLE public.fresh_marker_two (id int);
EOF
run_script "$SB1" db_fresh
echo "$OUT"
assert_eq "[1] 신선 설치 exit=0" "0" "$EXIT_CODE"
assert_eq "[1] 001 적용됨" "t" "$(sql1 db_fresh "SELECT to_regclass('public.fresh_marker_one') IS NOT NULL")"
assert_eq "[1] 002 적용됨" "t" "$(sql1 db_fresh "SELECT to_regclass('public.fresh_marker_two') IS NOT NULL")"
assert_eq "[1] 원장에 시딩 아닌 실행행 2건" "2" "$(sql1 db_fresh "SELECT COUNT(*) FROM public._sprintable_migration_ledger WHERE NOT seeded")"

# ── 시나리오 2: 무변경 재시작 — 같은 파일로 재실행, 전부 SKIP, 무오류 ──
echo
echo "== [2] 무변경 재시작(멱등) =="
run_script "$SB1" db_fresh
echo "$OUT"
assert_eq "[2] 무변경 재시작 exit=0" "0" "$EXIT_CODE"
assert_eq "[2] 원장 row 여전히 2건(중복 없음)" "2" "$(sql1 db_fresh "SELECT COUNT(*) FROM public._sprintable_migration_ledger")"
case "$OUT" in
  *"SKIP"*"001_ok.sql"*) echo "  ok   [2] 001 SKIP 로그 확認" ;;
  *) echo "  FAIL [2] 001 SKIP 로그 없음"; FAIL=1 ;;
esac

# ── 시나리오 3: 신규 파일 추가 재시작 — 003만 적용, 001/002는 SKIP ──
echo
echo "== [3] 신규 파일 추가 재시작 =="
cat > "$SB1/packages/db/supabase/migrations/003_new.sql" <<'EOF'
CREATE TABLE public.fresh_marker_three (id int);
EOF
run_script "$SB1" db_fresh
echo "$OUT"
assert_eq "[3] 신규 파일 추가 재시작 exit=0" "0" "$EXIT_CODE"
assert_eq "[3] 003 적용됨" "t" "$(sql1 db_fresh "SELECT to_regclass('public.fresh_marker_three') IS NOT NULL")"
assert_eq "[3] 원장 row 3건" "3" "$(sql1 db_fresh "SELECT COUNT(*) FROM public._sprintable_migration_ledger")"

# ── 시나리오 4: 실패 halt — 기존 pin 유지 확인 + 수정 후 재시작 시 이어서 진행 ──
echo
echo "== [4] 실패 halt(기존 pin 유지) =="
createdb -h 127.0.0.1 -p "$PORT" -U postgres db_fail
SB4="$(mk_sandbox sb_fail)"
cat > "$SB4/packages/db/supabase/migrations/001_ok.sql" <<'EOF'
CREATE TABLE public.fail_marker_one (id int);
EOF
cat > "$SB4/packages/db/supabase/migrations/002_broken.sql" <<'EOF'
THIS IS NOT VALID SQL AT ALL;
EOF
cat > "$SB4/packages/db/supabase/migrations/003_ok.sql" <<'EOF'
CREATE TABLE public.fail_marker_three (id int);
EOF
run_script "$SB4" db_fail
echo "$OUT"
assert_eq "[4] 고의 파손 시 exit!=0" "1" "$EXIT_CODE"
assert_eq "[4] 001(고장 이전) 적용됨" "t" "$(sql1 db_fail "SELECT to_regclass('public.fail_marker_one') IS NOT NULL")"
assert_eq "[4] 003(고장 이후) 절대 미적용" "f" "$(sql1 db_fail "SELECT to_regclass('public.fail_marker_three') IS NOT NULL")"
assert_eq "[4] 원장엔 001만 기록, 002/003은 없음" "1" "$(sql1 db_fail "SELECT COUNT(*) FROM public._sprintable_migration_ledger")"

echo "  → 002 수정 후 재시작 — 001은 SKIP, 002/003은 이어서 정상 진행되어야 함"
cat > "$SB4/packages/db/supabase/migrations/002_broken.sql" <<'EOF'
CREATE TABLE public.fail_marker_two (id int);
EOF
run_script "$SB4" db_fail
echo "$OUT"
assert_eq "[4] 수정 후 재시작 exit=0" "0" "$EXIT_CODE"
assert_eq "[4] 002 이제 적용됨" "t" "$(sql1 db_fail "SELECT to_regclass('public.fail_marker_two') IS NOT NULL")"
assert_eq "[4] 003도 이어서 적용됨" "t" "$(sql1 db_fail "SELECT to_regclass('public.fail_marker_three') IS NOT NULL")"
case "$OUT" in
  *"SKIP"*"001_ok.sql"*) echo "  ok   [4] 001은 재실행 안 되고 SKIP(기존 pin 유지) 확認" ;;
  *) echo "  FAIL [4] 001이 재실행되지 않았는지 SKIP 로그로 확인 불가"; FAIL=1 ;;
esac

# ── 시나리오 5: 기존 DB 시딩 — stories 실재 + 원장 부재 + CREATE POLICY 비멱등 재현 ──
echo
echo "== [5] 기존 DB 시딩(카디르가 찾은 회귀의 정면 재현) =="
createdb -h 127.0.0.1 -p "$PORT" -U postgres db_seed
SB5="$(mk_sandbox sb_seed)"
cat > "$SB5/packages/db/supabase/migrations/001_ok.sql" <<'EOF'
CREATE TABLE public.seed_marker_one (id int);
EOF
cat > "$SB5/packages/db/supabase/migrations/002_policy.sql" <<'EOF'
CREATE TABLE public.seed_marker_two (id int);
ALTER TABLE public.seed_marker_two ENABLE ROW LEVEL SECURITY;
CREATE POLICY seed_policy ON public.seed_marker_two FOR SELECT USING (true);
EOF
# "이미 예전 모델로 여러 재시작을 거친 self-host DB" 를 흉내 — stories(센티널) +
# 001/002가 실제로 이미 적용된 물리 상태를 원장 없이 만든다.
sql1 db_seed "CREATE TABLE public.stories (id int)" > /dev/null
sql1 db_seed "$(cat "$SB5/packages/db/supabase/migrations/001_ok.sql")" > /dev/null
sql1 db_seed "$(cat "$SB5/packages/db/supabase/migrations/002_policy.sql")" > /dev/null

run_script "$SB5" db_seed
echo "$OUT"
assert_eq "[5] 시딩 경로 exit=0(CREATE POLICY 중복충돌 없음)" "0" "$EXIT_CODE"
assert_eq "[5] 원장 row 2건 전부 seeded=true" "2" "$(sql1 db_seed "SELECT COUNT(*) FROM public._sprintable_migration_ledger WHERE seeded")"
assert_eq "[5] 실행행(비시딩)은 0건 — 실제로 안 돌았음" "0" "$(sql1 db_seed "SELECT COUNT(*) FROM public._sprintable_migration_ledger WHERE NOT seeded")"
assert_eq "[5] 정책 중복 없이 정확히 1건" "1" "$(sql1 db_seed "SELECT COUNT(*) FROM pg_policies WHERE tablename='seed_marker_two'")"

echo "  → 시딩 직후 재재시작 — 이제 원장이 있으니 정상 SKIP 경로(무회귀)"
run_script "$SB5" db_seed
echo "$OUT"
assert_eq "[5] 시딩 이후 재시작도 exit=0" "0" "$EXIT_CODE"

# ── 시나리오 6: 동시 기동 — advisory lock으로 직렬화, 중복/충돌 없이 둘 다 성공 ──
echo
echo "== [6] 동시 기동(advisory lock 직렬화) =="
createdb -h 127.0.0.1 -p "$PORT" -U postgres db_concurrent
SB6="$(mk_sandbox sb_concurrent)"
cat > "$SB6/packages/db/supabase/migrations/001_ok.sql" <<'EOF'
CREATE TABLE public.conc_marker_one (id int);
EOF
cat > "$SB6/packages/db/supabase/migrations/002_ok.sql" <<'EOF'
CREATE TABLE public.conc_marker_two (id int);
EOF
cat > "$SB6/packages/db/supabase/migrations/003_ok.sql" <<'EOF'
CREATE TABLE public.conc_marker_three (id int);
EOF

( cd "$SB6" && sh scripts/run-migrations.sh "postgresql://postgres@127.0.0.1:$PORT/db_concurrent" ) >"$WORK/conc_a.txt" 2>&1 &
PID_A=$!
( cd "$SB6" && sh scripts/run-migrations.sh "postgresql://postgres@127.0.0.1:$PORT/db_concurrent" ) >"$WORK/conc_b.txt" 2>&1 &
PID_B=$!

wait "$PID_A"; EXIT_A=$?
wait "$PID_B"; EXIT_B=$?
echo "-- instance A --"; cat "$WORK/conc_a.txt"
echo "-- instance B --"; cat "$WORK/conc_b.txt"

assert_eq "[6] 동시 인스턴스 A exit=0" "0" "$EXIT_A"
assert_eq "[6] 동시 인스턴스 B exit=0" "0" "$EXIT_B"
assert_eq "[6] 원장 중복 없이 정확히 3건" "3" "$(sql1 db_concurrent "SELECT COUNT(*) FROM public._sprintable_migration_ledger")"
assert_eq "[6] 001 정확히 1회만 생성(중복 CREATE 충돌 없음)" "t" "$(sql1 db_concurrent "SELECT to_regclass('public.conc_marker_one') IS NOT NULL")"

# ── 시나리오 7(카디르 2라운드 ①) — cutoff 기반 "정상 업그레이드": 구 DB(stories 有,
# 원장 無)에 cutoff **이후** 신규 파일이 이미지에 실려 온 경우, 시딩이 그 신규 파일까지
# 무실행 처리해버리면 안 된다 — 반드시 실 실행돼야 한다 ──
echo
echo "== [7] cutoff 기반 정상 업그레이드(신규 파일은 시딩 대신 실 실행) =="
createdb -h 127.0.0.1 -p "$PORT" -U postgres db_upgrade
SB7="$(mk_sandbox sb_upgrade)"
cat > "$SB7/packages/db/supabase/migrations/001_ok.sql" <<'EOF'
CREATE TABLE public.upgrade_marker_one (id int);
EOF
cat > "$SB7/packages/db/supabase/migrations/002_new.sql" <<'EOF'
CREATE TABLE public.upgrade_marker_two (id int);
EOF
# "예전 모델로 001까지는 이미 실 적용된 구 DB" 상태를 원장 없이 흉내 — stories(센티널)+
# 001의 물리 효과만 미리 만든다. 002는 이 이미지에 신규로 실려온 파일이라 미적용 상태.
sql1 db_upgrade "CREATE TABLE public.stories (id int)" > /dev/null
sql1 db_upgrade "CREATE TABLE public.upgrade_marker_one (id int)" > /dev/null

export SPRINTABLE_MIGRATIONS_SEED_CUTOFF="001_ok.sql"
run_script "$SB7" db_upgrade
unset SPRINTABLE_MIGRATIONS_SEED_CUTOFF
echo "$OUT"
assert_eq "[7] 정상 업그레이드 exit=0" "0" "$EXIT_CODE"
assert_eq "[7] 001은 시딩(seeded=true)됨 — 재실행 안 됨" "t" "$(sql1 db_upgrade "SELECT seeded FROM public._sprintable_migration_ledger WHERE filename='001_ok.sql'")"
assert_eq "[7] 002는 시딩 아닌 실 실행(seeded=false)" "f" "$(sql1 db_upgrade "SELECT seeded FROM public._sprintable_migration_ledger WHERE filename='002_new.sql'")"
assert_eq "[7] 002가 실제로 실행돼 마커 테이블 생성됨(카디르 회귀의 정면 재현)" "t" "$(sql1 db_upgrade "SELECT to_regclass('public.upgrade_marker_two') IS NOT NULL")"

# ── 시나리오 8(카디르 2라운드 ②) — CONCURRENTLY 인덱스가 이전 시도에서 INVALID로
# 남은 상태(락 경합·중복키 등)에서 재기동 시, 원인이 해소됐다면 자가치유(DROP 후
# 재생성)로 valid 상태에 도달해야 한다 ──
echo
echo "== [8] INVALID 인덱스 자가치유(cONCURRENTLY 이전 실패 잔재 회복) =="
createdb -h 127.0.0.1 -p "$PORT" -U postgres db_invalididx
SB8="$(mk_sandbox sb_invalididx)"
cat > "$SB8/packages/db/supabase/migrations/001_idx.sql" <<'EOF'
CREATE TABLE IF NOT EXISTS public.dup_test (id int);
INSERT INTO public.dup_test (id) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM public.dup_test WHERE id = 1);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_dup_test_id ON public.dup_test(id);
EOF
# "이전 컨테이너 기동에서 CONCURRENTLY 빌드가 중복키로 실패해 INVALID 인덱스만 남은"
# 상태를 원장 없이 직접 재현 — 이 시점엔 중복 데이터가 있어 인덱스 빌드가 실패한다.
sql1 db_invalididx "CREATE TABLE public.dup_test (id int)" > /dev/null
sql1 db_invalididx "INSERT INTO public.dup_test VALUES (1),(1)" > /dev/null
psql -h 127.0.0.1 -p "$PORT" -U postgres -d db_invalididx -c \
  "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_dup_test_id ON public.dup_test(id)" >/dev/null 2>&1 || true
assert_eq "[8] 사전조건 — 실제로 INVALID 인덱스가 남았음" "f" "$(sql1 db_invalididx "SELECT indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='idx_dup_test_id'")"

# 데이터 문제 해소(중복 제거) — 이제 재시도하면 성공할 수 있는 상태.
sql1 db_invalididx "DELETE FROM public.dup_test a USING public.dup_test b WHERE a.ctid < b.ctid AND a.id = b.id" > /dev/null

export SPRINTABLE_MIGRATIONS_NONTX_ALLOWLIST="001_idx.sql"
run_script "$SB8" db_invalididx
unset SPRINTABLE_MIGRATIONS_NONTX_ALLOWLIST
echo "$OUT"
assert_eq "[8] 자가치유 후 exit=0" "0" "$EXIT_CODE"
assert_eq "[8] 원장에 정상 기록됨" "1" "$(sql1 db_invalididx "SELECT COUNT(*) FROM public._sprintable_migration_ledger WHERE filename='001_idx.sql'")"
assert_eq "[8] 인덱스가 최종적으로 VALID" "t" "$(sql1 db_invalididx "SELECT indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='idx_dup_test_id'")"
case "$OUT" in
  *"INVALID 인덱스 감지"*) echo "  ok   [8] 자가치유(선삭제) 로그 확認" ;;
  *) echo "  FAIL [8] 자가치유 로그 없음 — 선삭제 경로가 안 탔을 수 있음"; FAIL=1 ;;
esac

kill -TERM "$PG_SESSION_PID" 2>/dev/null || true
wait "$PG_SESSION_PID" 2>/dev/null || true

# ── 시나리오 9(카디르 재검토) — NONTX_ALLOWLIST 트립와이어. 3라운드(카디르)에서 이
# 트립와이어가 .test.sh 안에만 살고 CI 어디에도 안 걸려 있다는 지적을 받아, 실제 검증
# 로직은 scripts/lint_migrations_nontx_allowlist.sh로 뽑아 CI job(.github/workflows/
# ci.yml의 migrations-nontx-allowlist-lint)과 이 자리 양쪽이 그 스크립트 하나를 공유
# 호출한다(로직 이중화·드리프트 방지) — 여기서는 그 스크립트를 실제로 실행해 exit code로
# 판정한다 ──
echo
echo "== [9] NONTX_ALLOWLIST 트립와이어(공유 스크립트 호출, CI에도 동일 배선) =="
LINT_SCRIPT="$SCRIPT_DIR/lint_migrations_nontx_allowlist.sh"
LINT_OUT="$(sh "$LINT_SCRIPT" 2>&1)"
LINT_EXIT=$?
echo "$LINT_OUT"
assert_eq "[9] 실 코퍼스 CONCURRENTLY 분류 lint exit=0" "0" "$LINT_EXIT"

echo
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASS"
  exit 0
else
  echo "FAILURES ABOVE"
  exit 1
fi
