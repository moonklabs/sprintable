#!/bin/bash
# MCP Server Smoke Test
# Usage:
#   PM_API_URL=... AGENT_API_KEY=... bash scripts/smoke-test.sh
# Optional:
#   CURRENT_MEMBER_ID=... PROJECT_ID=... MEMBER_ID=... bash scripts/smoke-test.sh

set -euo pipefail

if [ -z "${PM_API_URL:-}" ] || [ -z "${AGENT_API_KEY:-}" ]; then
  echo "Error: PM_API_URL and AGENT_API_KEY required"
  exit 1
fi

MEMBER_ID="${MEMBER_ID:-${CURRENT_MEMBER_ID:-}}"

call_tool() {
  local name=$1
  local args=$2

  printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"%s","arguments":%s}}\n' "$name" "$args" | \
    PM_API_URL="$PM_API_URL" AGENT_API_KEY="$AGENT_API_KEY" \
    node dist/index.js 2>/dev/null | head -1
}

echo "=== MCP Server Smoke Test ==="
echo ""

# Build
echo "1. Building..."
pnpm run build
echo "✓ Build passed"
echo ""

# tools/list
echo "2. Testing tools/list via stdio..."
TOOL_LIST=$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
  PM_API_URL="$PM_API_URL" AGENT_API_KEY="$AGENT_API_KEY" \
  node dist/index.js 2>/dev/null | head -1)

TOOL_COUNT=$(echo "$TOOL_LIST" | python3 -c '
import json,sys
try:
  d = json.loads(sys.stdin.read())
  print(len(d.get("result", {}).get("tools", [])))
except Exception:
  print(0)
')

echo "✓ tools/list returned $TOOL_COUNT tools"
echo ""

if [ "$TOOL_COUNT" -lt 40 ]; then
  echo "✗ Expected >= 40 tools, got $TOOL_COUNT"
  exit 1
fi

# Optional payload smoke checks
if [ -n "${CURRENT_MEMBER_ID:-}" ]; then
  echo "3. Testing current project payloads..."
  CURRENT_RESULT=$(call_tool "list_stories" "{\"current_member_id\":\"$CURRENT_MEMBER_ID\"}")
  if echo "$CURRENT_RESULT" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); assert 'result' in d" 2>/dev/null; then
    echo "✓ list_stories current_member_id payload passed"
  else
    echo "✗ list_stories current_member_id payload failed — $CURRENT_RESULT"
    exit 1
  fi
  echo ""
fi

if [ -n "${PROJECT_ID:-}" ]; then
  echo "4. Testing explicit project payloads..."
  PROJECT_RESULT=$(call_tool "list_sprints" "{\"project_id\":\"$PROJECT_ID\"}")
  if echo "$PROJECT_RESULT" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); assert 'result' in d" 2>/dev/null; then
    echo "✓ list_sprints project_id payload passed"
  else
    echo "✗ list_sprints project_id payload failed — $PROJECT_RESULT"
    exit 1
  fi
  echo ""
fi

if [ -n "$MEMBER_ID" ]; then
  echo "5. Testing member-scoped payloads..."
  DASHBOARD_RESULT=$(call_tool "my_dashboard" "{\"member_id\":\"$MEMBER_ID\"}")
  if echo "$DASHBOARD_RESULT" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); assert 'result' in d" 2>/dev/null; then
    echo "✓ my_dashboard member_id payload passed"
  else
    echo "✗ my_dashboard member_id payload failed — $DASHBOARD_RESULT"
    exit 1
  fi
  echo ""
fi

echo "=== Smoke Test PASSED ==="
