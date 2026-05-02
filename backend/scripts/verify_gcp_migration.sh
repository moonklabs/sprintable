#!/usr/bin/env bash
# D-S9: GCP 전환 완료 검증 — Smoke 테스트 스크립트
#
# 사전 조건:
#   - D-S1~D-S8 전량 완료, Cloud Run prod 서비스 기동 중
#   - C-S11 배포 완료 (createAdminClient 제거)
#
# 사용법:
#   bash backend/scripts/verify_gcp_migration.sh
#   FRONTEND_URL=https://app.sprintable.ai \
#   BACKEND_URL=https://backend-prod-xxxx.run.app \
#   TEST_API_KEY=sk_live_xxx \
#   bash backend/scripts/verify_gcp_migration.sh
#
# 환경변수:
#   FRONTEND_URL   프론트엔드 Cloud Run URL (기본: https://app.sprintable.ai)
#   BACKEND_URL    백엔드 Cloud Run URL
#   TEST_API_KEY   테스트용 에이전트 API key (smoke CRUD용)

set -euo pipefail

FRONTEND_URL="${FRONTEND_URL:-https://app.sprintable.ai}"
BACKEND_URL="${BACKEND_URL:-}"
TEST_API_KEY="${TEST_API_KEY:-}"

PASS=0
FAIL=0

log()  { echo "[$(date '+%H:%M:%S')] $*" >&2; }
pass() { PASS=$((PASS+1)); log "✅ PASS: $*"; }
fail() { FAIL=$((FAIL+1)); log "❌ FAIL: $*"; }

check_http() {
  local label="$1" url="$2" expected_status="${3:-200}"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$url" 2>/dev/null || echo "000")
  if [[ "$status" == "$expected_status" ]]; then
    pass "$label (HTTP $status)"
  else
    fail "$label — expected $expected_status, got $status ($url)"
  fi
}

check_json_field() {
  local label="$1" url="$2" field="$3" auth_header="${4:-}"
  local curl_args=(-s --max-time 15)
  [[ -n "$auth_header" ]] && curl_args+=(-H "$auth_header")
  local body
  body=$(curl "${curl_args[@]}" "$url" 2>/dev/null || echo "{}")
  if echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); assert '$field' in str(d)" 2>/dev/null; then
    pass "$label (field: $field)"
  else
    fail "$label — field '$field' not found in response ($url)"
  fi
}

# ─── AC1.1: Health checks ───────────────────────────────────────────────────
log "=== AC1: Health Checks ==="

check_http "Frontend root" "$FRONTEND_URL" "200"
check_http "Frontend login page" "$FRONTEND_URL/login" "200"

if [[ -n "$BACKEND_URL" ]]; then
  check_http "Backend /api/health" "$BACKEND_URL/api/health" "200"
  check_http "Backend /api/v2/health" "$BACKEND_URL/api/v2/health" "200"
fi

check_http "Frontend /api/health (via proxy)" "$FRONTEND_URL/api/health" "200"

# ─── AC1.2: 로그인 페이지 렌더 ───────────────────────────────────────────────
log "=== AC1: Login Page Render ==="
check_http "Login page HTML" "$FRONTEND_URL/login" "200"

# ─── AC1.3: API CRUD (API key 인증) ─────────────────────────────────────────
log "=== AC1: API CRUD ==="
if [[ -n "$TEST_API_KEY" ]]; then
  check_json_field "GET /api/v2/me" "$FRONTEND_URL/api/v2/me" "id" "Authorization: Bearer $TEST_API_KEY"
  check_json_field "GET /api/sprints (via Next.js)" "$FRONTEND_URL/api/sprints" "data" "Authorization: Bearer $TEST_API_KEY"
  check_json_field "GET /api/epics (via Next.js)" "$FRONTEND_URL/api/epics" "data" "Authorization: Bearer $TEST_API_KEY"
  check_json_field "GET /api/stories (via Next.js)" "$FRONTEND_URL/api/stories" "data" "Authorization: Bearer $TEST_API_KEY"
else
  log "⚠️  TEST_API_KEY 미설정 — CRUD 검증 생략"
fi

# ─── AC1.4: SSE 엔드포인트 ──────────────────────────────────────────────────
log "=== AC1: SSE Endpoint ==="
if [[ -n "$TEST_API_KEY" ]]; then
  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
    -H "Authorization: Bearer $TEST_API_KEY" \
    "$FRONTEND_URL/api/events" 2>/dev/null || echo "000")
  # SSE는 200 또는 401 (미인증) 반환 — connection 자체가 열리는지 확인
  if [[ "$status" == "200" || "$status" == "401" || "$status" == "403" ]]; then
    pass "SSE /api/events endpoint reachable (HTTP $status)"
  else
    fail "SSE /api/events — got $status"
  fi
fi

# ─── 결과 요약 ────────────────────────────────────────────────────────────────
log ""
log "=== Smoke Test 결과 ==="
log "PASS: $PASS  FAIL: $FAIL"

if [[ $FAIL -eq 0 ]]; then
  log "✅ 전체 PASS — Cloud Run 정상 서빙 확인"
  exit 0
else
  log "❌ $FAIL건 FAIL — 운영팀 확인 필요"
  exit 1
fi
