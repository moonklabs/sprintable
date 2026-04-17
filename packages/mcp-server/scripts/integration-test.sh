#!/bin/bash
# MCP Server Integration Test — current project / explicit project representative tools
# Usage:
#   PM_API_URL=... \
#   AGENT_API_KEY=... \
#   CURRENT_MEMBER_ID=... \
#   PROJECT_ID=... \
#   MEMBER_ID=... \
#   bash scripts/integration-test.sh

set -euo pipefail

if [ -z "${PM_API_URL:-}" ] || [ -z "${AGENT_API_KEY:-}" ] || [ -z "${CURRENT_MEMBER_ID:-}" ] || [ -z "${PROJECT_ID:-}" ]; then
  echo "Error: PM_API_URL, AGENT_API_KEY, CURRENT_MEMBER_ID, PROJECT_ID required"
  exit 1
fi

MEMBER_ID="${MEMBER_ID:-$CURRENT_MEMBER_ID}"
PASS=0
FAIL=0

call_tool() {
  local name=$1
  local args=$2
  local result

  result=$(printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"%s","arguments":%s}}\n' "$name" "$args" | \
    PM_API_URL="$PM_API_URL" AGENT_API_KEY="$AGENT_API_KEY" \
    node dist/index.js 2>/dev/null | head -1)

  if echo "$result" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); assert 'result' in d" 2>/dev/null; then
    echo "  ✓ $name"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $name — $result"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== MCP Integration Test (explicit + current project mix) ==="
echo "Project: $PROJECT_ID"
echo "Current member: $CURRENT_MEMBER_ID"
echo "Member: $MEMBER_ID"
echo ""

pnpm run build >/dev/null

echo "Testing strict project tools..."
call_tool "list_sprints" "{\"project_id\":\"$PROJECT_ID\"}"
call_tool "list_epics" "{\"project_id\":\"$PROJECT_ID\"}"

echo ""
echo "Testing current project tools..."
call_tool "list_stories" "{\"current_member_id\":\"$CURRENT_MEMBER_ID\"}"
call_tool "list_backlog" "{\"current_member_id\":\"$CURRENT_MEMBER_ID\"}"
call_tool "list_tasks" "{\"current_member_id\":\"$CURRENT_MEMBER_ID\"}"
call_tool "list_my_tasks" "{\"current_member_id\":\"$CURRENT_MEMBER_ID\"}"
call_tool "list_team_members" "{\"current_member_id\":\"$CURRENT_MEMBER_ID\"}"
call_tool "list_memos" "{\"current_member_id\":\"$CURRENT_MEMBER_ID\"}"
call_tool "get_project_overview" "{\"current_member_id\":\"$CURRENT_MEMBER_ID\"}"
call_tool "get_project_health" "{\"current_member_id\":\"$CURRENT_MEMBER_ID\",\"days\":14}"
call_tool "search_stories" "{\"current_member_id\":\"$CURRENT_MEMBER_ID\",\"query\":\"test\"}"

echo ""
echo "Testing member-scoped tools..."
call_tool "my_dashboard" "{\"member_id\":\"$MEMBER_ID\"}"
call_tool "check_notifications" "{\"member_id\":\"$MEMBER_ID\"}"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

echo "✓ All integration tests passed"
