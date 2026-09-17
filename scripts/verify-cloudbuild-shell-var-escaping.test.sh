#!/usr/bin/env bash
# story #4012 CHANGES(페드루 PO 지적) AC — verify-cloudbuild-shell-var-escaping.py의
# 순수 함수 양성/음성 대조(--self-test, 대문자 셸 변수만 위반·소문자는 조용함 포함)와,
# 실 cloudbuild.yaml에 대한 실 스캔(위반 0건이어야 함) 둘 다 확인.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/verify-cloudbuild-shell-var-escaping.py"

FAIL=0
check() {
  local label="$1" expect_exit="$2"; shift 2
  local out
  out="$("$@" 2>&1)"
  local actual_exit=$?
  if [ "$actual_exit" -eq "$expect_exit" ]; then
    echo "  ok   $label (exit=$actual_exit)"
  else
    echo "  FAIL $label — expected exit $expect_exit, got $actual_exit — $out"
    FAIL=1
  fi
}

echo "== verify-cloudbuild-shell-var-escaping.py =="
check "순수 함수 양성/음성 대조(이 PR 옛 버그 포함)" 0 python3 "$SCRIPT" --self-test
check "실 cloudbuild.yaml 스캔 — 위반 0건" 0 python3 "$SCRIPT"

echo
if [ "$FAIL" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "FAILURES ABOVE"; exit 1; fi
