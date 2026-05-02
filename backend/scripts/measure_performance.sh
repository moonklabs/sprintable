#!/usr/bin/env bash
# D-S9: Cloud Run 응답시간 측정 — p50/p95/p99 baseline 기록
#
# 사용법:
#   FRONTEND_URL=https://app.sprintable.ai \
#   TEST_API_KEY=sk_live_xxx \
#   bash backend/scripts/measure_performance.sh
#
# 환경변수:
#   FRONTEND_URL   측정 대상 URL
#   TEST_API_KEY   에이전트 API key
#   ITERATIONS     측정 반복 횟수 (기본: 20)
#   OUTPUT_FILE    결과 파일 (기본: /tmp/sprintable_perf_$(date +%Y%m%d).json)

set -euo pipefail

FRONTEND_URL="${FRONTEND_URL:-https://app.sprintable.ai}"
TEST_API_KEY="${TEST_API_KEY:-}"
ITERATIONS="${ITERATIONS:-20}"
OUTPUT_FILE="${OUTPUT_FILE:-/tmp/sprintable_perf_$(date +%Y%m%d_%H%M%S).json}"

log() { echo "[$(date '+%H:%M:%S')] $*" >&2; }

if ! command -v python3 &>/dev/null; then
  echo "python3 required" >&2; exit 1
fi

measure_endpoint() {
  local label="$1" url="$2" auth="${3:-}"
  local times=()
  local curl_args=(-s -o /dev/null -w "%{time_total}" --max-time 30)
  [[ -n "$auth" ]] && curl_args+=(-H "Authorization: Bearer $auth")

  log "측정 중: $label ($ITERATIONS 회)"
  for _ in $(seq 1 "$ITERATIONS"); do
    local t
    t=$(curl "${curl_args[@]}" "$url" 2>/dev/null || echo "30")
    times+=("$t")
    sleep 0.5
  done

  # Python으로 p50/p95/p99 계산
  python3 - "${times[@]}" <<'PYEOF'
import sys, json, statistics
vals = sorted(float(x) * 1000 for x in sys.argv[1:])  # ms 변환
n = len(vals)
def percentile(data, p):
    idx = int(len(data) * p / 100)
    return round(data[min(idx, len(data)-1)], 1)
result = {
    "count": n,
    "p50_ms": percentile(vals, 50),
    "p95_ms": percentile(vals, 95),
    "p99_ms": percentile(vals, 99),
    "min_ms": round(min(vals), 1),
    "max_ms": round(max(vals), 1),
    "mean_ms": round(statistics.mean(vals), 1),
}
print(json.dumps(result))
PYEOF
}

# ─── cold start 측정 (단일 요청 — 서비스 재시작 후 첫 요청 아님) ──────────────
log "=== p50/p95/p99 측정 시작 ==="
log "대상: $FRONTEND_URL"

HEALTH_RESULT=$(measure_endpoint "GET /api/health" "$FRONTEND_URL/api/health")
log "health: $HEALTH_RESULT"

if [[ -n "$TEST_API_KEY" ]]; then
  ME_RESULT=$(measure_endpoint "GET /api/v2/me" "$FRONTEND_URL/api/v2/me" "$TEST_API_KEY")
  log "/api/v2/me: $ME_RESULT"

  STORIES_RESULT=$(measure_endpoint "GET /api/stories" "$FRONTEND_URL/api/stories" "$TEST_API_KEY")
  log "/api/stories: $STORIES_RESULT"
fi

# ─── 결과 저장 ─────────────────────────────────────────────────────────────
python3 - "$HEALTH_RESULT" "${ME_RESULT:-null}" "${STORIES_RESULT:-null}" "$FRONTEND_URL" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" <<PYEOF > "$OUTPUT_FILE"
import sys, json
health = json.loads(sys.argv[1])
me = json.loads(sys.argv[2]) if sys.argv[2] != "null" else None
stories = json.loads(sys.argv[3]) if sys.argv[3] != "null" else None
result = {
    "measured_at": sys.argv[5],
    "target_url": sys.argv[4],
    "baseline": {
        "health": health,
        "me": me,
        "stories": stories,
    }
}
print(json.dumps(result, indent=2))
PYEOF

log "결과 저장: $OUTPUT_FILE"
cat "$OUTPUT_FILE"
