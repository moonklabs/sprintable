#!/usr/bin/env bash
# story #2659 AC2 — check-disk-usage.sh가 오늘 사고 수치(100%, /System/Volumes/Data)로 실제
# alert=true·exit 2를 내는지, 그리고 정상/경계값에서 조용한지 실행 결과로 잰다.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-disk-usage.sh"

FAIL=0
check() {
  local label="$1" expect_exit="$2"; shift 2
  local out
  out="$("$@" 2>&1)"
  local actual_exit=$?
  if [ "$actual_exit" -eq "$expect_exit" ]; then
    echo "  ok   $label (exit=$actual_exit) — $out"
  else
    echo "  FAIL $label — expected exit $expect_exit, got $actual_exit — $out"
    FAIL=1
  fi
}

echo "== check-disk-usage.sh =="
# 오늘 사고 재현 — 917/926 = 100%(반올림) 시나리오, 기본 임계 90.
check "사고 재현(100% 사용) → alert" 2 "$SCRIPT" --self-test-percent 100
# 사고 진행 중 관측된 87% 지점(아직 90% 미만) → 조용해야 정상.
check "87% 사용(임계 90 미만) → 조용" 0 "$SCRIPT" --self-test-percent 87 --threshold 90
# 정확히 임계값 → 경보(>= 기준, 오늘처럼 "딱 그 순간"을 놓치지 않게).
check "정확히 임계값(90%) → alert" 2 "$SCRIPT" --self-test-percent 90 --threshold 90
# 커스텀 임계값도 존중되는지.
check "커스텀 임계 85%에서 86% → alert" 2 "$SCRIPT" --self-test-percent 86 --threshold 85
check "커스텀 임계 85%에서 84% → 조용" 0 "$SCRIPT" --self-test-percent 84 --threshold 85
# 실제 df 경로(이 머신의 현재 상태) — exit 0 또는 2만 나오면 정상(파싱 실패인 exit 1이면 버그).
out="$("$SCRIPT" 2>&1)"; ec=$?
if [ "$ec" -eq 0 ] || [ "$ec" -eq 2 ]; then
  echo "  ok   실 df 경로(현재 머신) 파싱 성공 — $out"
else
  echo "  FAIL 실 df 경로 파싱 실패(exit=$ec) — $out"
  FAIL=1
fi

echo
if [ "$FAIL" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "FAILURES ABOVE"; exit 1; fi
