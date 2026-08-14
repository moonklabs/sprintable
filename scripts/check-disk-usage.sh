#!/usr/bin/env bash
# story #2659(2026-08-14) — 2026-08-14 fleet 전면 장애 사후 처방 ⓑ. 그날 실제로 100%까지 찬
# 볼륨은 `/`가 아니라 `/System/Volumes/Data`였다(macOS APFS 컨테이너 — `/`는 읽기전용 시스템
# 볼륨이라 용량이 안 참다). 이 스크립트는 «탐지만» 한다 — 어디로 경보를 보낼지(Discord/Sprintable
# 이벤트/기타)는 머신 레벨 배선(cron 등록 포함) 담당인 PO 쪽 스코프. 이 스크립트는 그 배선이
# 파이프로 소비할 수 있게 종료코드+JSON 한 줄로만 결과를 낸다.
#
# 종료코드: 0=정상  2=임계 초과(경보 트리거)  1=측정 실패(df 파싱 불가 등 — 이것도 자체로
#   이상신호이니 조용히 삼키지 않는다).
#
# 사용법:
#   scripts/check-disk-usage.sh                    # 기본 90% 임계, /System/Volumes/Data(macOS)
#   scripts/check-disk-usage.sh --threshold 85
#   scripts/check-disk-usage.sh --mount /
#
# 오늘 사고 재현(AC2 "실측"): 사고 당시 `df -h /System/Volumes/Data` = 926Gi 중 900Gi 사용
#   (100%, 여유 117Mi) — 이 스크립트를 그 수치로 되돌려 넣으면(아래 --self-test) alert=true를
#   낸다. 실측 스모크는 check-disk-usage.test.sh 참고.

set -euo pipefail

THRESHOLD=90
MOUNT="/System/Volumes/Data"
SELF_TEST_PERCENT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --threshold) THRESHOLD="$2"; shift 2 ;;
    --mount) MOUNT="$2"; shift 2 ;;
    --self-test-percent) SELF_TEST_PERCENT="$2"; shift 2 ;; # 테스트 전용 — df 우회, 고정 % 주입.
    *) echo "unknown arg: $1" >&2; exit 64 ;;
  esac
done

if [ -n "$SELF_TEST_PERCENT" ]; then
  USED_PERCENT="$SELF_TEST_PERCENT"
else
  # df -P(POSIX 출력형식 — 컬럼 줄바꿈 없음, macOS/Linux 공통) 마지막 줄의 Capacity(%) 컬럼.
  DF_LINE="$(df -P "$MOUNT" 2>/dev/null | tail -n 1)" || { echo '{"error":"df failed"}' >&2; exit 1; }
  if [ -z "$DF_LINE" ]; then
    echo '{"error":"no df output for mount '"$MOUNT"'"}' >&2
    exit 1
  fi
  USED_PERCENT="$(printf '%s' "$DF_LINE" | awk '{print $5}' | tr -d '%')"
fi

if ! [ "$USED_PERCENT" -eq "$USED_PERCENT" ] 2>/dev/null; then
  echo '{"error":"could not parse usage percent","raw":"'"${DF_LINE:-}"'"}' >&2
  exit 1
fi

ALERT=false
if [ "$USED_PERCENT" -ge "$THRESHOLD" ]; then
  ALERT=true
fi

printf '{"mount":"%s","used_percent":%d,"threshold":%d,"alert":%s}\n' \
  "$MOUNT" "$USED_PERCENT" "$THRESHOLD" "$ALERT"

if [ "$ALERT" = true ]; then
  exit 2
fi
exit 0
