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
# 짧게 줘서 기본 30초를 기다리지 않는다(CI 실제 값은 여전히 30초 그대로). 제한시간을
# 0.05분(3초)으로(0.02분=1.2초보다 넉넉히) 잡아 `date +%s` 1초 해상도 경계오차를 피한다
# (경과시간 대조가 4라운드에 새로 들어갔으므로 — 아래 참고).
set +e
OUT="$(STALL_KILL_AFTER=2s "$SCRIPT" 0.05 -- bash -c 'trap "" TERM; sleep 60' 2>&1)"
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
echo "── 즉발 외부 SIGKILL(137)은 제한시간 도달 前이면 STALL로 안 새고 원 코드 그대로 ──"
# 페드루 PO CHANGES(PR#4348 4라운드, 카디르 재현) — 137은 우리 KILL escalation
# 말고도 외부(OOM killer 등, 우리 제한시간과 무관)에서도 나올 수 있다. 넉넉한
# 제한시간(60초) 안에서 명령이 스스로 즉시 자기 자신에게 SIGKILL을 보내면(실측 경과
# ≪ 60초) STALL로 오분류되면 안 되고, 137을 있는 그대로 돌려줘야 한다.
set +e
OUT="$("$SCRIPT" 1 -- bash -c 'kill -9 $$' 2>&1)"
CODE=$?
set -e
if [ "$CODE" -eq 137 ]; then
  echo "  ok   즉발 SIGKILL은 137 그대로 전달(제한시간 60초 도달 前이므로 STALL 아님)"
else
  echo "  FAIL exit code=${CODE}(기대 137, 즉발 SIGKILL 원코드 보존)"
  FAIL=1
fi
if [[ "$OUT" != *"STALL"* ]]; then
  echo "  ok   STALL 메시지 없음(우리 정지 감지가 한 일이 아니므로)"
else
  echo "  FAIL 즉발 SIGKILL인데 STALL로 오분류됨 — 출력: $OUT"
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
