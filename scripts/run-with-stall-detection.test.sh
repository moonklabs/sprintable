#!/usr/bin/env bash
# story #3944 AC2 — run-with-stall-detection.sh 양성대조 2건(cleanup-ci-artifacts.test.sh와
# 동형 원칙: 실물 대신 통제된 합성 커맨드로 "정지=실패/진행 中(완주)=통과"를 실행 결과로
# 고정한다). GNU coreutils timeout(1)이 필요 — macOS는 `brew install coreutils`(gtimeout)
# 후 PATH에 gnubin을 얹어야 한다(CI 러너 ubuntu-latest는 기본 내장, 별도 조치 불요).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/run-with-stall-detection.sh"

if ! command -v timeout >/dev/null 2>&1; then
  echo "SKIP: timeout(1)이 PATH에 없습니다(macOS면 'brew install coreutils' 후 gnubin을 PATH에 얹으세요)" >&2
  exit 0
fi

FAIL=0

echo "── 정지(합성 샤드가 제한 시간 안에 안 끝남) → STALL 실패 ──"
set +e
OUT="$("$SCRIPT" 0.02 -- sleep 5 2>&1)"
CODE=$?
set -e
if [ "$CODE" -eq 124 ]; then
  echo "  ok   exit code 124(coreutils timeout 관례값)"
else
  echo "  FAIL exit code=${CODE}(기대 124)"
  FAIL=1
fi
if [[ "$OUT" == *"STALL"* ]]; then
  echo "  ok   STALL 메시지 출력됨"
else
  echo "  FAIL STALL 메시지가 안 보임 — 출력: $OUT"
  FAIL=1
fi

echo
echo "── TERM 무시(고아 프로세스 방지) → KILL escalation도 결국 124로 정규화 ──"
# 페드루 PO CHANGES(PR#4348 잔여①) — 자식이 TERM을 씹으면(uv/pytest가 신호를 못
# 넘기는 경우의 재현) `-k`가 KILL까지 보내는지, 그리고 그 KILL 경로(coreutils
# 실측 exit 137)도 이 래퍼가 124로 정규화해 돌려주는지 실측한다. STALL_KILL_AFTER를
# 짧게 줘서 기본 30초를 기다리지 않는다(CI 실제 값은 여전히 30초 그대로).
set +e
OUT="$(STALL_KILL_AFTER=1s "$SCRIPT" 0.02 -- bash -c 'trap "" TERM; sleep 60' 2>&1)"
CODE=$?
set -e
if [ "$CODE" -eq 124 ]; then
  echo "  ok   TERM 무시해도 KILL 뒤 exit 124로 정규화됨(137 그대로 새지 않음)"
else
  echo "  FAIL exit code=${CODE}(기대 124) — TERM 무시 시 KILL escalation이 137로 샐 수 있음"
  FAIL=1
fi
if [[ "$OUT" == *"STALL"* ]] && [[ "$OUT" == *"KILL"* ]]; then
  echo "  ok   STALL 메시지가 KILL escalation 여부를 명시함"
else
  echo "  FAIL STALL/KILL 메시지 누락 — 출력: $OUT"
  FAIL=1
fi

echo
echo "── 진행 中(제한 시간 안에 정상 완주) → 통과(원 종료 코드 그대로) ──"
set +e
OUT="$("$SCRIPT" 0.5 -- sleep 0.1 2>&1)"
CODE=$?
set -e
if [ "$CODE" -eq 0 ]; then
  echo "  ok   정상 완주 시 exit code 0 그대로 통과"
else
  echo "  FAIL exit code=${CODE}(기대 0)"
  FAIL=1
fi
if [[ "$OUT" != *"STALL"* ]]; then
  echo "  ok   STALL 메시지 없음(정지 아니었으므로)"
else
  echo "  FAIL 정상 완주인데 STALL 메시지가 나왔다 — 출력: $OUT"
  FAIL=1
fi

echo
echo "── 명령 자체의 정상 실패(정지 아님)는 원 종료 코드를 그대로 전달 ──"
set +e
OUT="$("$SCRIPT" 0.5 -- bash -c 'exit 3' 2>&1)"
CODE=$?
set -e
if [ "$CODE" -eq 3 ]; then
  echo "  ok   원 종료 코드(3) 그대로 전달 — 정지 판정과 일반 실패를 혼동하지 않는다"
else
  echo "  FAIL exit code=${CODE}(기대 3)"
  FAIL=1
fi
if [[ "$OUT" != *"STALL"* ]]; then
  echo "  ok   STALL 메시지 없음(정상 종료였으므로)"
else
  echo "  FAIL 일반 실패인데 STALL 메시지가 나왔다 — 출력: $OUT"
  FAIL=1
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASS"
  exit 0
else
  echo "FAILURES ABOVE"
  exit 1
fi
