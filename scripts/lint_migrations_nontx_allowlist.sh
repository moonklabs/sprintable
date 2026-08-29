#!/bin/sh
# story #3219(2026-08-30, 카디르 3라운드) — «만들어졌는데 CI에 안 도는» 가드 결함 지적:
# run-migrations.test.sh 시나리오 [9]가 실 코퍼스를 스캔해 NONTX_ALLOWLIST 갱신 의무를
# 지키는지 확인했지만, 그 .test.sh는 CI 어디에도 안 걸려 있어 매 PR에 실제로 도는 자리가
# 없었다 — allowlist가 오래돼 낡아도 아무도 못 알아채는 구조. 처방: 이 검증을 독립
# 스크립트로 뽑아 CI job(.github/workflows/ci.yml)과 run-migrations.test.sh [9] 양쪽에서
# 공유 호출한다 — 로직이 두 군데로 갈라져 서로 드리프트하는 것도 같이 막는다.
#
# NONTX_ALLOWLIST는 새 top-level CONCURRENTLY 파일이 생길 때마다 실제로 갱신 의무가
# 남는 자리다(scripts/run-migrations.sh 헤더 ③단락 참고 — SEED_CUTOFF와 달리 영구
# 동결이 아님). 이 스캔은 PG 없이 실 코퍼스만 보고 "CONCURRENTLY 포함 파일 ⊆
# (NONTX_ALLOWLIST ∪ 함수본문-전용 선언목록)"을 검증한다.
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/packages/db/supabase/migrations"
RUN_MIGRATIONS_SH="$SCRIPT_DIR/run-migrations.sh"

NONTX_ALLOWLIST="$(grep -oE "SPRINTABLE_MIGRATIONS_NONTX_ALLOWLIST:-[^}]*" "$RUN_MIGRATIONS_SH" | sed 's/^[^:]*:-//')"
if [ -z "$NONTX_ALLOWLIST" ]; then
  echo "FAIL: run-migrations.sh에서 NONTX_ALLOWLIST 기본값을 추출하지 못함(정규식 drift?)"
  exit 1
fi

# 실측(2026-08-30)으로 CONCURRENTLY가 BEGIN...END 함수 본문 **안**에만 있어 top-level이
# 아님을 직접 확인한 파일 — 새로 추가되는 파일은 여기 없으니 이 스캔이 반드시 잡는다.
# 재분류 시: top-level이면 → run-migrations.sh의 NONTX_ALLOWLIST에 추가.
#            함수 본문 안이면 → 아래 목록에 추가(`grep -B2 -A2 "CONCURRENTLY" <file>`로
#            BEGIN...END 안인지 직접 눈으로 확인 후).
FUNCTION_BODY_ONLY_DECLARED="20260407110000_monthly_agent_usage_view.sql 20260408092000_agent_hitl_pending_status.sql 20260425140000_reward_balances_view.sql"

UNACCOUNTED=""
for f in "$MIGRATIONS_DIR"/*.sql; do
  name="$(basename "$f")"
  if grep -q "CONCURRENTLY" "$f"; then
    accounted=false
    for known in $NONTX_ALLOWLIST $FUNCTION_BODY_ONLY_DECLARED; do
      if [ "$known" = "$name" ]; then
        accounted=true
        break
      fi
    done
    if [ "$accounted" = false ]; then
      UNACCOUNTED="$UNACCOUNTED $name"
    fi
  fi
done

if [ -n "$UNACCOUNTED" ]; then
  echo "FAIL: 다음 파일이 CONCURRENTLY를 포함하지만 run-migrations.sh의 NONTX_ALLOWLIST에도"
  echo "      이 스크립트의 FUNCTION_BODY_ONLY_DECLARED(함수 본문 안임을 수동 검증한 목록)에도 없다:"
  for name in $UNACCOUNTED; do
    echo "  - $name"
  done
  echo "grep -B2 -A2 \"CONCURRENTLY\" <file> 로 top-level인지 직접 확인한 뒤:"
  echo "  top-level이면        → run-migrations.sh의 NONTX_ALLOWLIST에 추가"
  echo "  함수 본문(BEGIN...END) 안이면 → 이 스크립트의 FUNCTION_BODY_ONLY_DECLARED에 추가"
  exit 1
fi

echo "OK: CONCURRENTLY 포함 파일 전부 allowlist∪함수본문-선언에 계정됨"
