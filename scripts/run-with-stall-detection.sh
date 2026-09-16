#!/usr/bin/env bash
# story #3944(2026-09-16, 페드루 PO 판정) — destructive 샤드 job의 30분 timeout이
# "멈춤"을 잡으려던 것인데 실제로 재는 건 "오래 걸림"이라, 동시 PR 부하로 러너 하나가
# 과점유되면 형제 샤드는 정상 완주하는데 그 인스턴스 1개만 진행 中인 채(마지막 파일에
# 계속 진입 중) 죽는 사고가 반복됐다(2026-09-16 shard0/shard3, 둘 다 정확히 30:1x분
# kill·취소 직전까지 파일 통과 계속·진행률로 외삽하면 47~48분이면 완주). #2293의
# "천장을 올려도 다음 표본에서 다시 붙는다"는 «천장이 판정 자일 때»의 이야기 — 이
# 스크립트는 판정 자를 "경과 시간"에서 "이 명령 하나가 끝났는가"로 옮긴다. job
# timeout-minutes는 이 스크립트가 있는 한 절대 안 닿는 백스톱일 뿐이다.
#
# 사용법: run-with-stall-detection.sh <timeout_minutes> -- <command...>
#   지정 시간(분) 안에 command가 안 끝나면 강제종료하고 STALL 메시지를 stderr에
#   찍은 뒤 exit 124(coreutils timeout(1)의 관례값 그대로 — 새 계약 발명 금지).
#   command가 스스로 끝나면 그 종료 코드를 그대로 돌려준다(성공/실패 무변경).
set -uo pipefail

if [ "$#" -lt 3 ] || [ "$2" != "--" ]; then
  echo "usage: $0 <timeout_minutes> -- <command...>" >&2
  exit 64
fi

TIMEOUT_MIN="$1"
shift 2

# 페드루 PO CHANGES①(PR#4348 리뷰) — `timeout`은 기본 TERM만 보낸다. uv가 자식
# pytest에 TERM을 못 넘기면(예: uv 자신이 신호를 무시·전달 지연) 고아 pytest가 같은
# Postgres 세션을 붙든 채 남아 «다음 파일이 오염된 DB에서 실패」로 나와 정지 원인이
# 가려진다 — `-k`로 TERM 뒤 일정 시간 안에 안 죽으면 KILL(무시 불가)까지 확실히
# 보낸다. 기본 30초(CI 실제 값)지만 자가진단(TERM 무시 양성대조)이 30초씩 기다리지
# 않도록 STALL_KILL_AFTER 환경값으로 짧게 주입할 수 있게 뺐다.
KILL_AFTER="${STALL_KILL_AFTER:-30s}"
timeout -k "$KILL_AFTER" "${TIMEOUT_MIN}m" "$@"
code=$?

# 페드루 PO CHANGES(PR#4348 잔여③ 자가진단 그라운딩 중 실측 발견) — GNU coreutils
# timeout(1) 매뉴얼: TERM만으로 죽으면 124, 그런데 TERM을 무시해 KILL(9)까지 가면
# **137**(128+9)로 exit code가 달라진다(실측: `timeout -k 1s 1s bash -c 'trap "" TERM;
# sleep 60'` → exit 137, 2초 소요 — 124가 아니었다). 이 스크립트의 계약은 "정지=124"
# 하나뿐이므로 KILL 경로도 여기서 124로 정규화한다 — 호출부(ci.yml 루프)가 137까지
# 따로 알아야 하면 계약이 새는 것.
if [ "$code" -eq 137 ]; then
  echo "STALL: 명령이 ${TIMEOUT_MIN}분 안에 안 끝나 강제 종료됨(TERM 무시 → ${KILL_AFTER} 뒤 KILL escalation) — $*" >&2
  exit 124
elif [ "$code" -eq 124 ]; then
  echo "STALL: 명령이 ${TIMEOUT_MIN}분 안에 안 끝나 강제 종료됨 — $*" >&2
fi

exit "$code"
