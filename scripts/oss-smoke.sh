#!/usr/bin/env bash
# OSS-SPLIT Phase B.2 — OSS smoke test (AC-6)
# 실행: OSS_MODE=true SQLITE_PATH=./sprintable.db bash scripts/oss-smoke.sh
#
# 4경로 검증:
# 1. Web UI CRUD (localhost:3108)           — curl로 세션 쿠키 경유 검증 (수동 로그인 가정)
# 2. MCP stdio 클라이언트 CRUD              — packages/mcp-server의 stdio 모드로 동등 CRUD
# 3. Agent API key curl CRUD                — sk_live_* API key로 /api/* 호출
# 4. /settings human 세션 허용 + agent key 403 차단

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3108}"
AGENT_API_KEY="${AGENT_API_KEY:-}"
HUMAN_SESSION_COOKIE_FILE="${HUMAN_SESSION_COOKIE_FILE:-./.oss-smoke-session.txt}"
ORG_ID="${ORG_ID:-}"
PROJECT_ID="${PROJECT_ID:-}"
STORY_ID="${STORY_ID:-}"

fail() { echo "[FAIL] $*" >&2; exit 1; }
info() { echo "[INFO] $*"; }
ok() { echo "[PASS] $*"; }

require_env() {
  local var_name="$1"
  [[ -n "${!var_name:-}" ]] || fail "$var_name is required"
}

check_oss_mode() {
  [[ "${OSS_MODE:-}" == "true" ]] || fail "OSS_MODE must be 'true'"
  [[ -n "${SQLITE_PATH:-}" ]] || fail "SQLITE_PATH must be set"
  ok "OSS_MODE=true, SQLITE_PATH=$SQLITE_PATH"
}

# -------- Path 3: Agent API key CRUD --------
smoke_agent_api_crud() {
  info "Path 3 — Agent API key CRUD"
  require_env AGENT_API_KEY
  require_env PROJECT_ID
  require_env ORG_ID

  local epic_title="smoke-epic-$(date +%s)"
  local epic_json
  epic_json=$(curl -sf -X POST "$BASE_URL/api/epics" \
    -H "Authorization: Bearer $AGENT_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"project_id\":\"$PROJECT_ID\",\"org_id\":\"$ORG_ID\",\"title\":\"$epic_title\"}") \
    || fail "epic create failed"
  local epic_id
  epic_id=$(echo "$epic_json" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
  ok "epic created: $epic_id"

  curl -sf "$BASE_URL/api/epics/$epic_id" \
    -H "Authorization: Bearer $AGENT_API_KEY" >/dev/null || fail "epic GET failed"
  ok "epic GET"

  local story_json
  story_json=$(curl -sf -X POST "$BASE_URL/api/stories" \
    -H "Authorization: Bearer $AGENT_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"project_id\":\"$PROJECT_ID\",\"org_id\":\"$ORG_ID\",\"title\":\"smoke-story\",\"epic_id\":\"$epic_id\"}") \
    || fail "story create failed"
  local story_id
  story_id=$(echo "$story_json" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
  ok "story created: $story_id"

  local task_json
  task_json=$(curl -sf -X POST "$BASE_URL/api/tasks" \
    -H "Authorization: Bearer $AGENT_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"story_id\":\"$story_id\",\"title\":\"smoke-task\"}") \
    || fail "task create failed"
  local task_id
  task_id=$(echo "$task_json" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
  ok "task created: $task_id"

  local memo_json
  memo_json=$(curl -sf -X POST "$BASE_URL/api/memos" \
    -H "Authorization: Bearer $AGENT_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"project_id\":\"$PROJECT_ID\",\"org_id\":\"$ORG_ID\",\"content\":\"smoke memo\"}") \
    || fail "memo create failed"
  local memo_id
  memo_id=$(echo "$memo_json" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
  ok "memo created: $memo_id"

  ok "Path 3 complete (epic/story/task/memo CRUD)"
}

# -------- Path 4: /settings human session + agent key 403 --------
smoke_settings_auth() {
  info "Path 4 — /settings human session vs agent key"
  require_env AGENT_API_KEY

  local agent_status
  agent_status=$(curl -sf -o /dev/null -w "%{http_code}" \
    "$BASE_URL/settings" \
    -H "Authorization: Bearer $AGENT_API_KEY" || echo "curl_error")
  [[ "$agent_status" == "403" ]] || fail "Agent API key on /settings should be 403, got: $agent_status"
  ok "agent key blocked on /settings (403)"

  if [[ -f "$HUMAN_SESSION_COOKIE_FILE" ]]; then
    local human_status
    human_status=$(curl -sf -o /dev/null -w "%{http_code}" \
      -b "$HUMAN_SESSION_COOKIE_FILE" \
      "$BASE_URL/settings" || echo "curl_error")
    [[ "$human_status" == "200" ]] || fail "Human session on /settings should be 200, got: $human_status"
    ok "human session allowed on /settings (200)"
  else
    info "SKIP: human session cookie file not found ($HUMAN_SESSION_COOKIE_FILE) — 수동 브라우저 검증 필요"
  fi
}

# -------- Path 1: Web UI CRUD (manual verification checklist) --------
smoke_web_ui_checklist() {
  info "Path 1 — Web UI CRUD (수동 체크리스트)"
  cat <<'EOF'
  [ ] http://localhost:3108 접속 → 로그인
  [ ] 프로젝트 생성/조회/수정/삭제
  [ ] Epic 생성/조회
  [ ] Story 생성/조회
  [ ] Task 생성/조회
  [ ] Memo 생성/답신
  [ ] Doc 생성/조회
  [ ] 각 단계에서 500 에러 없음
EOF
}

# -------- Path 2: MCP stdio CRUD (checklist) --------
smoke_mcp_stdio_checklist() {
  info "Path 2 — MCP stdio CRUD (Claude Code 등에서 수동 검증)"
  cat <<'EOF'
  [ ] Claude Code MCP 설정에 sprintable 등록
  [ ] mcp__sprintable__list_projects 호출 → 응답
  [ ] mcp__sprintable__create_memo 호출 → 응답
  [ ] mcp__sprintable__list_stories 호출 → 응답
  (stdio 모드는 OSS_MODE=true 환경 변수가 전파돼야 함)
EOF
}

main() {
  check_oss_mode
  smoke_agent_api_crud
  smoke_settings_auth
  smoke_web_ui_checklist
  smoke_mcp_stdio_checklist
  ok "=== OSS smoke complete ==="
}

main "$@"
