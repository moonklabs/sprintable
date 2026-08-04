#!/usr/bin/env bash
# story #2446 — §6 결승선 오케스트레이터.
#
# 순서를 코드로 강제한다(사람이 순서를 지키는 게 아니라):
#   1. generator_selfcheck.js 로 «생성기 단독 상한»이 이 런의 최대 목표 rps보다 높은지
#      먼저 증명. achieved < target*0.95 면 **여기서 즉시 중단** — 뒤 단계를 아예 안 돈다.
#      (생성기가 못 뽑는데 서버 결과를 재는 건 Run 1이 빠질 뻔한 그 오판을 다시 만드는 것)
#   2. 통과 시에만 endpoint_mix_test.js 를 ramp 스테이지(기본 50→100→200→300)로 순차 실행.
#      스테이지 사이에 kill-switch(에러율·p95 임계) 검사 — breach 시 다음 스테이지 «중단».
#
# 실행 대상: dev 만(BASE_URL 기본값이 dev). prod 는 선생님 창+go 전까지 이 스크립트로
# 실행 금지 — BASE_URL 을 prod 로 바꿔서 돌리는 것도 포함(경계는 사람 판단, 코드가 막진
# 않음 — 실행 전 review 필수).
#
# 사용:
#   CREDS_FILE=./loadtest_creds.json ./run_loadtest.sh
#   STAGES="50 100 200 300" STAGE_DURATION=60s ./run_loadtest.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BASE_URL="${BASE_URL:-https://sprintable-backend-dev-787818285179.asia-northeast3.run.app}"
CREDS_FILE="${CREDS_FILE:-./loadtest_creds.json}"
STAGES="${STAGES:-50 100 200 300}"
STAGE_DURATION="${STAGE_DURATION:-60s}"
RAMP_UP="${RAMP_UP:-10s}"
RAMP_DOWN="${RAMP_DOWN:-5s}"
# kill-switch 임계 — 「명백히 무너짐」만 감지하는 보수적 값(§6 Gate의 정상가동 목표인
# p95<500ms·error<0.1%보다 훨씬 느슨: 그 목표는 «pass/fail 판정» 기준이고, 이건 「계속
# 진행해도 안전한가」의 kill 기준이라 다르다). 스테이지 «사이»(run_loadtest.sh)와 스테이지
# «내부»(endpoint_mix_test.js/generator_selfcheck.js의 k6 native abortOnFail) 둘 다 이
# 값을 env var로 공유(카디르 QA 2026-08-04 — SSOT 하나, 드리프트 방지).
KILL_ERROR_RATE="${KILL_ERROR_RATE:-0.05}"    # 5%
KILL_P95_MS="${KILL_P95_MS:-2000}"            # 2s
OUT_DIR="${OUT_DIR:-/tmp/loadtest-run-$(date +%s 2>/dev/null || echo run)}"

mkdir -p "$OUT_DIR"
echo "[run_loadtest] BASE_URL=$BASE_URL OUT_DIR=$OUT_DIR"

if [[ ! -f "$CREDS_FILE" ]]; then
  echo "[run_loadtest] FATAL: CREDS_FILE not found: $CREDS_FILE" >&2
  echo "  seed with: python -m scripts.jobs.seed_loadtest_identities (see README)" >&2
  exit 2
fi

MAX_TARGET=0
for s in $STAGES; do
  (( s > MAX_TARGET )) && MAX_TARGET=$s
done

# ---- Phase 1: generator self-check (positive control) ----------------------------------
# ramp_expected.py: iterations.rate(전체구간 평균)를 target과 직접 비교하지 않는다 —
# 램프업/다운이 평균을 구조적으로 깎아 정상 생성기도 오판-fail한다(실측, 스크립트
# 헤더 참조). achieved iteration «개수»를 기대 개수(사다리꼴 적분)와 비교한다.
SELFCHECK_RAMP_UP="${SELFCHECK_RAMP_UP:-5s}"
SELFCHECK_RAMP_DOWN="${SELFCHECK_RAMP_DOWN:-3s}"
SELFCHECK_DURATION="${SELFCHECK_DURATION:-20s}"

echo "[run_loadtest] Phase 1/2: generator self-check (target=$MAX_TARGET rps ceiling, +20% headroom)"
SELFCHECK_JSON="$OUT_DIR/selfcheck.json"
SELFCHECK_TARGET=$(python3 -c "import math; print(math.ceil(int('$MAX_TARGET') * 1.2))")
BASE_URL="$BASE_URL" TARGET_RATE="$MAX_TARGET" SELFCHECK_DURATION="$SELFCHECK_DURATION" \
  SELFCHECK_RAMP_UP="$SELFCHECK_RAMP_UP" SELFCHECK_RAMP_DOWN="$SELFCHECK_RAMP_DOWN" \
  KILL_ERROR_RATE="$KILL_ERROR_RATE" KILL_P95_MS="$KILL_P95_MS" \
  k6 run --summary-export="$SELFCHECK_JSON" generator_selfcheck.js | tee "$OUT_DIR/selfcheck.log"

SELFCHECK_ACHIEVED_COUNT=$(python3 -c "
import json
d = json.load(open('$SELFCHECK_JSON'))
print(d['metrics']['iterations']['count'])
")
SELFCHECK_EXPECTED_COUNT=$(python3 ramp_expected.py "$SELFCHECK_RAMP_UP" "$SELFCHECK_DURATION" "$SELFCHECK_RAMP_DOWN" "$SELFCHECK_TARGET")
SELFCHECK_PASS=$(python3 -c "
achieved = $SELFCHECK_ACHIEVED_COUNT
expected = $SELFCHECK_EXPECTED_COUNT
print('yes' if achieved >= expected * 0.95 else 'no')
")
SELFCHECK_PCT=$(python3 -c "print(round(100 * $SELFCHECK_ACHIEVED_COUNT / $SELFCHECK_EXPECTED_COUNT, 1))")

echo "[run_loadtest] self-check: achieved=${SELFCHECK_ACHIEVED_COUNT} iterations, expected=${SELFCHECK_EXPECTED_COUNT} (${SELFCHECK_PCT}%), attempted_rate=${SELFCHECK_TARGET} rps, pass=${SELFCHECK_PASS}"
if [[ "$SELFCHECK_PASS" != "yes" ]]; then
  echo "[run_loadtest] FATAL: generator itself cannot sustain ${MAX_TARGET} rps (achieved ${SELFCHECK_PCT}% of expected iterations, need >=95%)." >&2
  echo "  이 상태로 endpoint_mix_test.js 를 돌려도 achieved-rate 부족이 «서버 캡」인지 «생성기 기아」인지 못 가른다 — 중단." >&2
  echo "  대책: 단일 머신 CPU/네트워크가 병목이면 여러 워커/Cloud Run Job으로 분산해 재시도(README §분산 참조)." >&2
  exit 1
fi
echo "[run_loadtest] self-check PASS — proceeding to ramp stages."

# ---- Phase 2: ramp stages ----------------------------------------------------------------
echo "[run_loadtest] Phase 2/2: ramp stages [$STAGES], stage duration=$STAGE_DURATION"
PREV_STATUS=0
for RATE in $STAGES; do
  STAGE_JSON="$OUT_DIR/stage_${RATE}.json"
  echo "[run_loadtest] --- stage rate=${RATE} rps ---"
  set +e
  BASE_URL="$BASE_URL" CREDS_FILE="$CREDS_FILE" RATE="$RATE" \
    STAGE_DURATION="$STAGE_DURATION" RAMP_UP="$RAMP_UP" RAMP_DOWN="$RAMP_DOWN" \
    KILL_ERROR_RATE="$KILL_ERROR_RATE" KILL_P95_MS="$KILL_P95_MS" \
    k6 run --summary-export="$STAGE_JSON" endpoint_mix_test.js | tee "$OUT_DIR/stage_${RATE}.log"
  set -e

  ATTEMPTED="$RATE"
  # 원시(전체구간 평균) rate — 참고용으로만 보고한다. 램프업/다운이 이 값을 구조적으로
  # 깎으므로(selfcheck와 동일 이유) kill-switch/판정에는 쓰지 않는다.
  ACHIEVED_RAW_RATE=$(python3 -c "
import json
d = json.load(open('$STAGE_JSON'))
print(d['metrics']['iterations']['rate'])
")
  ACHIEVED_COUNT=$(python3 -c "
import json
d = json.load(open('$STAGE_JSON'))
print(d['metrics']['iterations']['count'])
")
  EXPECTED_COUNT=$(python3 ramp_expected.py "$RAMP_UP" "$STAGE_DURATION" "$RAMP_DOWN" "$RATE")
  # 램프 프로파일 기준 「실효 achieved rps」 — target을 achieved/expected 개수비로 스케일.
  # selfcheck와 동일 원리(rate 대 rate 비교는 램프에 오염됨) — 이게 실제 「달성 vs 시도」 수치.
  ACHIEVED=$(python3 -c "print(round($RATE * $ACHIEVED_COUNT / $EXPECTED_COUNT, 2))")
  ERROR_RATE=$(python3 -c "
import json
d = json.load(open('$STAGE_JSON'))
m = d['metrics'].get('http_req_failed', {})
print(m.get('rate', m.get('value', 0)))
")
  P95=$(python3 -c "
import json
d = json.load(open('$STAGE_JSON'))
m = d['metrics'].get('http_req_duration', {})
print(m.get('p(95)', 0))
")
  P50=$(python3 -c "
import json
d = json.load(open('$STAGE_JSON'))
m = d['metrics'].get('http_req_duration', {})
print(m.get('med', 0))
")
  P99=$(python3 -c "
import json
d = json.load(open('$STAGE_JSON'))
m = d['metrics'].get('http_req_duration', {})
print(m.get('p(99)', 0))
")

  echo "[run_loadtest] stage=${RATE} attempted=${ATTEMPTED} achieved(ramp-adjusted)=${ACHIEVED} achieved(raw avg)=${ACHIEVED_RAW_RATE} error_rate=${ERROR_RATE} p50=${P50}ms p95=${P95}ms p99=${P99}ms"
  echo "${ATTEMPTED},${ACHIEVED},${ACHIEVED_RAW_RATE},${ERROR_RATE},${P50},${P95},${P99}" >> "$OUT_DIR/summary.csv"

  BREACH=$(python3 -c "
err = $ERROR_RATE
p95 = $P95
print('yes' if (err > $KILL_ERROR_RATE or p95 > $KILL_P95_MS) else 'no')
")
  if [[ "$BREACH" == "yes" ]]; then
    echo "[run_loadtest] KILL-SWITCH: stage ${RATE} breached (error_rate=${ERROR_RATE} > ${KILL_ERROR_RATE} or p95=${P95}ms > ${KILL_P95_MS}ms) — aborting remaining stages." >&2
    echo "attempted_rps,achieved_rps_ramp_adjusted,achieved_rps_raw_avg,error_rate,p50_ms,p95_ms,p99_ms" | cat - "$OUT_DIR/summary.csv" > "$OUT_DIR/summary_with_header.csv" 2>/dev/null || true
    exit 3
  fi
done

echo "attempted_rps,achieved_rps_ramp_adjusted,achieved_rps_raw_avg,error_rate,p50_ms,p95_ms,p99_ms" | cat - "$OUT_DIR/summary.csv" > "$OUT_DIR/summary_with_header.csv"
echo "[run_loadtest] all stages complete, no kill-switch breach. summary: $OUT_DIR/summary_with_header.csv"
cat "$OUT_DIR/summary_with_header.csv"
