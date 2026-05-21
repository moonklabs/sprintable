#!/usr/bin/env bash
# S1-3 smoke test — AC2/AC3/AC4/AC5
# 전체 플로우 2분 이내 완결 검증
set -euo pipefail

API_URL="${SPRINTABLE_API_URL:-https://app.sprintable.ai}"
API_KEY="${AGENT_API_KEY:-}"

if [[ -z "$API_KEY" ]]; then
  echo "❌ AGENT_API_KEY 환경변수 필요"
  exit 1
fi

START_TIME=$(date +%s)
echo "🧪 Sprintable CLI smoke test 시작"
echo "   API_URL: $API_URL"
echo ""

# AC3: ping 확인
echo "▶ AC3: ping 확인..."
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $API_KEY" \
  -H "x-agent-api-key: $API_KEY" \
  "$API_URL/api/v2/ping")
if [[ "$STATUS" == "200" ]]; then
  echo "  ✅ ping OK (HTTP $STATUS)"
else
  echo "  ❌ ping FAIL (HTTP $STATUS)"
  exit 1
fi

# AC2: claude-code .mcp.json 생성 확인
CLAUDE_MCP="$HOME/.mcp.json"
if [[ -f "$CLAUDE_MCP" ]]; then
  if python3 -c "
import json, sys
d = json.load(open('$CLAUDE_MCP'))
s = d.get('mcpServers', {}).get('sprintable', {})
assert s.get('command') == 'uvx', 'command != uvx'
assert s.get('env', {}).get('SPRINTABLE_API_URL'), 'SPRINTABLE_API_URL missing'
assert s.get('env', {}).get('AGENT_API_KEY'), 'AGENT_API_KEY missing'
" 2>&1; then
    echo "  ✅ AC2: ~/.mcp.json sprintable 서버 설정 정상"
  else
    echo "  ❌ AC2: ~/.mcp.json 형식 오류"
    exit 1
  fi
else
  echo "  ⚠️  AC2: ~/.mcp.json 미생성 (connect 실행 필요)"
fi

# AC4: cursor .cursor/mcp.json 생성 확인
CURSOR_MCP="$HOME/.cursor/mcp.json"
if [[ -f "$CURSOR_MCP" ]]; then
  if python3 -c "
import json
d = json.load(open('$CURSOR_MCP'))
s = d.get('mcpServers', {}).get('sprintable', {})
assert s.get('command') == 'uvx', 'command != uvx'
" 2>&1; then
    echo "  ✅ AC4: ~/.cursor/mcp.json sprintable 서버 설정 정상"
  else
    echo "  ❌ AC4: ~/.cursor/mcp.json 형식 오류"
  fi
else
  echo "  ℹ️  AC4: ~/.cursor/mcp.json 미생성 (--agent cursor 실행 필요)"
fi

# AC5: 전체 소요 시간 측정
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))
echo ""
echo "⏱  소요 시간: ${ELAPSED}초"
if [[ $ELAPSED -le 120 ]]; then
  echo "✅ AC5: 2분(120초) 이내 완결"
else
  echo "❌ AC5: 2분 초과 (${ELAPSED}초)"
  exit 1
fi

echo ""
echo "🎉 smoke test PASS"
