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
#   찍은 뒤 exit 124(coreutils timeout(1)의 관례값 그대로 — 새 계약 발명 금지). TERM을
#   무시해 KILL escalation까지 간 경우(coreutils 자체 실측 137)도 실제로 제한시간에
#   도달했을 때만 여기 포함해 124로 정규화한다.
#   command가 스스로 끝나거나, 제한시간 도달 前에 외부 원인(예: 진짜 SIGKILL)으로
#   죽으면 그 종료 코드를 그대로 돌려준다(성공/실패/외부종료 무변경).
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
# 페드루 PO CHANGES(PR#4348 5라운드, 카디르 재현) — `date +%s`(초 절삭)는 경과시간을
# 항상 "크게" 재는 쪽으로 편향된다(예: 8분 제한에서 실제 7.99분 뒤 즉발 137이 와도
# 절삭 때문에 elapsed가 480s로 반올림돼 STALL로 잘못 새는 창이 생김 — 8분처럼 큰
# 제한에선 ≤1s라 무시해도 되지만, 합성 테스트처럼 초 단위 제한에선 그 창이 전체의
# 상당 비율이라 실제로 샌다). `%s.%N`(나노초)+awk 실수 비교로 그 창을 구조적으로 닫는다.
_start=$(date +%s.%N)
if [ -n "${STALL_EVIDENCE_DIR:-}" ]; then
  # story #4319(AC5) — 죽이기 전에 증거: 제한 STALL_EVIDENCE_LEAD_SEC(기본 60초) 전에 명령이 아직 돌고 있으면
  # stall-evidence.sh가 DB 연결 · 잠금과 pytest 스레드 · asyncio 태스크 스택을 로그에 남긴다. 명령이 먼저 끝나면 수집기를
  # 거둬 정상 판엔 아무 일도 안 한다(AC7). STALL_EVIDENCE_DIR이 없으면 예전 경로 그대로.
  mkdir -p "$STALL_EVIDENCE_DIR"
  _lead="${STALL_EVIDENCE_LEAD_SEC:-60}"
  _fire_at=$(awk "BEGIN { v = ${TIMEOUT_MIN} * 60 - ${_lead}; if (v < 0) v = 0; printf \"%.3f\", v }")
  timeout -k "$KILL_AFTER" "${TIMEOUT_MIN}m" "$@" &
  _cmd_pid=$!
  (
    # 뒤로 돌린 sleep을 wait한다 — 앞쪽 sleep이 거둬지면(명령이 먼저 끝남) 셸이 파일마다 «Terminated»를 로그에 찍었다(CI 대조 판 실측).
    sleep "$_fire_at" &
    wait $! || exit 0
    if kill -0 "$_cmd_pid" 2>/dev/null; then
      "$(dirname "${BASH_SOURCE[0]}")/stall-evidence.sh" "$_cmd_pid" "$STALL_EVIDENCE_DIR"
    fi
  ) &
  _collector_pid=$!
  wait "$_cmd_pid"
  code=$?
  # 명령이 먼저 끝났으면 아직 자는 수집기(와 그 sleep)를 거둔다 — 이미 수집 중이면 끝날 때까지 기다린다(덤프가 잘리지 않게).
  # (수집 중이면 수집기의 직계 자식은 sleep이 아니라 stall-evidence.sh라 건드리지 않는다.)
  pkill -P "$_collector_pid" -x sleep 2>/dev/null || true
  wait "$_collector_pid" 2>/dev/null || true
else
  timeout -k "$KILL_AFTER" "${TIMEOUT_MIN}m" "$@"
  code=$?
fi
_limit_sec=$(awk "BEGIN { printf \"%.9f\", (${TIMEOUT_MIN} * 60) }")
# 페드루 PO CHANGES(PR#4348 6라운드, 카디르 재현) — 직전 버전은 `%.3f`로 반올림한
# 문자열을 그 뒤 비교에도 그대로 재사용해, 예를 들어 raw 0.5996s(제한 0.6s 直前)가
# 0.600으로 반올림돼 "제한 도달"로 오분류될 수 있었다(0.4ms 경계 실측). 반올림은
# **로그 출력 전용**으로만 쓰고, 판정 비교는 raw float끼리 한 awk 안에서 직접 뺄셈+
# 비교한다(중간에 문자열로 왕복하며 반올림이 끼어들 자리를 아예 없앰).
# STALL_TEST_ELAPSED_OVERRIDE — 자가진단이 실제 wall-clock 경계 타이밍(수백 μs~ms 폭)에
# 기대지 않고 이 경계 판정 자체를 결정론적으로 고정할 수 있게 하는 테스트 전용 훅
# (프로덕션 경로에선 절대 설정 안 됨 — 설정 시 실측 대신 그 값을 그대로 raw elapsed로 씀).
if [ -n "${STALL_TEST_ELAPSED_OVERRIDE:-}" ]; then
  _raw_elapsed="$STALL_TEST_ELAPSED_OVERRIDE"
else
  _raw_elapsed=$(awk "BEGIN { printf \"%.9f\", $(date +%s.%N) - ${_start} }")
fi
_elapsed_fmt=$(awk "BEGIN { printf \"%.3f\", ${_raw_elapsed} }")

# 페드루 PO CHANGES(PR#4348 잔여③→4라운드) — GNU coreutils timeout(1) 매뉴얼:
# TERM만으로 죽으면 124, TERM을 무시해 KILL(9)까지 가면 **137**(128+9)로 exit code가
# 달라진다(실측: `timeout -k 1s 1s bash -c 'trap "" TERM; sleep 60'` → exit 137).
# 다만 137은 우리 KILL escalation 말고도 **외부에서 온 진짜 SIGKILL**(OOM killer 등,
# 이 스크립트의 제한시간과 무관)에서도 나온다(카디르 재현) — 그 즉발 137까지 STALL로
# 정규화하면 "왜 멈췄는지"가 거짓으로 찍힌다. 그래서 137은 실측 경과시간이 우리
# 제한시간(TIMEOUT_MIN)에 실제로 도달했을 때만 STALL(124 정규화)로 판정하고, 그 전에
# (제한시간 도달 전) 137이 오면 우리 정지감지가 한 일이 아니므로 137 그대로 전달한다.
# (124는 coreutils 자신이 "시간이 다 됐다"고 판단했을 때만 나오는 값이라 이 모호함이
# 없다 — 경과시간 대조 불필요.)
if [ "$code" -eq 137 ]; then
  if awk "BEGIN { exit !(${_raw_elapsed} >= ${_limit_sec}) }"; then
    echo "STALL: 명령이 ${TIMEOUT_MIN}분 안에 안 끝나 강제 종료됨(TERM 무시 → ${KILL_AFTER} 뒤 KILL escalation) — $*" >&2
    exit 124
  else
    echo "명령이 외부 SIGKILL(137)로 즉시 종료됨(경과 ${_elapsed_fmt}s < 제한 ${_limit_sec}s) — 이 스크립트의 정지 감지와 무관, 원 코드 그대로 전달 — $*" >&2
  fi
elif [ "$code" -eq 124 ]; then
  echo "STALL: 명령이 ${TIMEOUT_MIN}분 안에 안 끝나 강제 종료됨 — $*" >&2
fi

exit "$code"
