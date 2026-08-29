#!/usr/bin/env bash
# story #3199 — macOS 호스트 SysV shm(kern.sysv.shmmni=32, 로컬 기본값·시스템 전체 상한)이
# disposable PG initdb의 shmget으로 쉽게 saturate돼(우리 disposable PG들이 종료 trap 없이
# 죽으면서 세그를 반납 못 하고 누적) 반복 기동이 막히던 문제(미르코·저자 동형 재현)의 정리
# 루틴. `-c shared_memory_type=mmap`을 써도 안 풀렸던 이유: PG≥9.3은 shared_memory_type과
# 무관하게 클러스터당 SysV 세그 1개(소형 인터록용)를 항상 추가로 잡기 때문 — 그 1개가
# 32/32 saturation에 걸리면 mmap 여부와 무관하게 ENOSPC.
#
# 카디르 QA(PR#3616 head cd21e1794) HIGH 2건 반영:
#   ①세션 모드가 foreground `sleep 3600`으로 signal을 최악 1시간 잡아두던 것 — 이 스크립트가
#     막으려는 바로 그 "종료 trap 지연" 결함을 자기가 재생산하고 있었다. 백그라운드 sleep+
#     `wait`(bash에서 트랩된 시그널에 즉시 인터럽트됨)+INT/TERM 트랩이 명시 exit하는 구조로
#     교체 — EXIT 트랩(cleanup)이 그 exit로 인해 정확히 한 번만 실행된다.
#   ②이전 주석 "attach 중인 프로세스는 안 죽는다"는 절반만 정직했다 — IPC_RMID는 이미
#     attach된 프로세스는 안 죽이지만, **그 순간부터 그 세그에 대한 신규 attach를 전부
#     막는다.** 즉 무고한 live 세그를 잘못 걸면 "죽지는 않되 새 커넥션(새 backend attach)이
#     그때부터 실패하기 시작"하는 실질 피해가 있다 — 그래서 스윕을 **평시엔 절대 안 돈다**로
#     좁혔다: 먼저 정상 기동을 시도하고, initdb/pg_ctl start가 shm 관련 사유로 실패했을
#     때만(로그에서 shmget/ENOSPC 시그니처 확인) 스윕 후 1회 재시도한다 — 무고한 세그를
#     건드리는 창 자체가 "포화로 실제 실패했을 때"로만 좁혀진다.
#
# 기동 전이 아니라 **실패 시에만** 이 호스트의 "죽은 disposable PG 잔재" shm 세그를
# non-root ipcrm으로 스윕한다. 판별은 추정이 아니라 실물 대조: PG postmaster는 자기 SysV
# 세그의 key/shmid를 postmaster.pid 7번째 줄에 스스로 기록하므로(PG≥10 표준 포맷, 같은
# uid라 읽기 가능), 그걸로 살아있는 클러스터를 실물 확認해 제외하고 나머지만 지운다.
#
# live 클러스터 탐색은 well-known 경로 추정(brew 경로 등)이 아니라 **실행 중인 postmaster
# 전수**로 한다 — 이 스토리의 발단 자체가 «두 저자 동형 재현»(병행 세션)이라, 다른 세션이
# 임의 data-dir에서 띄운 disposable PG도 실사용 경로다(페드루 QA 지적, PR#3616). `ps`로
# `postgres -D <dir>` 커맨드라인 전부를 찾아 그 dir들의 postmaster.pid를 전부 읽는다 —
# brew 경로는 이 일반 스캔에 자연히 흡수되어 더 이상 특례가 아니다. 실제 제거 직전에도 이
# live 목록을 한 번 더 재수집해(1차 스냅샷~제거 사이 TOCTOU 창을 좁힘) 그 사이 새로 뜬
# 병행 세션까지 반영한다.
#
# 못 잡는 것(선언): ⓐ다른 uid가 띄운 PG — 그 postmaster.pid를 못 읽지만, 같은 이유로
# 커널이 그 uid의 shm을 ipcrm으로부터도 막아주므로 안전(EPERM, 스윕에서 조용히 스킵 —
# EPERM 외의 ipcrm 실패는 조용히 삼키지 않고 stderr로 낸다). ⓑ같은 uid의 PG 아닌 SysV
# 사용자(다른 도구가 shm을 쓰는 경우) — 이건 진짜 미탐지 리스크. ⓒ data-dir 경로에
# 공백이 들어가면 `-D` 파싱(sed)이 그 지점에서 끊긴다 — disposable 리그 관례상 실경로엔
# 공백이 없어 지금은 무해하나, 공백 포함 경로를 쓰게 되면 재점검 필요.
#
# 사용:
#   backend/scripts/disposable_pg.sh <data-dir> <port>              # 세션 모드(Ctrl-C까지 유지)
#   backend/scripts/disposable_pg.sh <data-dir> <port> -- <command>  # 원샷(명령 실행 후 자동 stop, 그 종료코드로 exit)
#   - data-dir가 없으면 initdb로 새로 만든다(진짜 disposable — 매번 신선한 클러스터).
#   - 종료(EXIT/INT/TERM 무엇이든) trap이 pg_ctl stop -m fast로 항상 shm을 반납한다 —
#     다음 실행이 오늘 이걸 다시 겪지 않도록.
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <data-dir> <port> [-- <command...>]" >&2
  exit 2
fi

DATA_DIR="$1"
PORT="$2"
shift 2
if [ "${1:-}" = "--" ]; then
  shift
fi

PG_BIN_DIR="$(dirname "$(command -v postgres 2>/dev/null || echo /opt/homebrew/opt/postgresql@16/bin/postgres)")"
export PATH="$PG_BIN_DIR:$PATH"

_live_shmids() {
  local line dir pidfile line7
  while IFS= read -r line; do
    dir="$(sed -n 's/.* -D  *\([^ ]*\).*/\1/p' <<<"$line")"
    [ -n "$dir" ] || continue
    pidfile="$dir/postmaster.pid"
    [ -f "$pidfile" ] || continue
    line7="$(sed -n '7p' "$pidfile" 2>/dev/null || true)"
    [ -n "$line7" ] || continue
    awk '{print $2}' <<<"$line7"
  done < <(ps -axwwo command 2>/dev/null | grep -E '/postgres( |$)' | grep -F ' -D ')
}

_id_in() {
  # $1=id, $2=목록(개행 구분 문자열 하나)
  local id="$1" list="$2" found
  while read -r found; do
    [ -n "$found" ] && [ "$id" = "$found" ] && return 0
  done <<<"$list"
  return 1
}

sweep_orphan_shm() {
  local live_ids id candidates=()
  # 1차 스냅샷으로 후보(비-live로 보이는 세그)만 추린다 — 아직 아무것도 안 지움.
  live_ids="$(_live_shmids)"
  while read -r id; do
    [ -n "$id" ] || continue
    _id_in "$id" "$live_ids" || candidates+=("$id")
  done < <(ipcs -m 2>/dev/null | awk '/^m/ {print $2}')

  [ "${#candidates[@]}" -eq 0 ] && return 0

  # 실 제거 직전 live 목록을 한 번 더 재수집 — 1차 스냅샷~지금 사이 새로 뜬 병행 세션(다른
  # 저자 세션 등)을 반영해 TOCTOU 창을 좁힌다.
  live_ids="$(_live_shmids)"
  local err rc
  for id in "${candidates[@]}"; do
    _id_in "$id" "$live_ids" && continue
    # 페드루 코스메틱 지적(PR#3616 재QA) — `if ! err=$(...); then rc=$?` 형태는 `!`가 이미
    # 조건을 부정한 뒤라 그 안의 `$?`는 항상 0(부정 자체의 성공)을 찍는다. 실제 종료코드는
    # `&&`/`||`로 조건 밖에서 따로 잡아야 한다.
    err="$(ipcrm -m "$id" 2>&1 >/dev/null)" && rc=0 || rc=$?
    if [ "$rc" -ne 0 ]; then
      if ! grep -qiE 'not permitted|permission denied' <<<"$err"; then
        echo "ipcrm -m $id 실패(rc=$rc, EPERM 아님): $err" >&2
      fi
    fi
  done
}

cleanup() {
  pg_ctl -D "$DATA_DIR" -m fast stop >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

_shm_failure_signature() {
  grep -qiE 'shmget|no space left on device' "$1" 2>/dev/null
}

if [ ! -d "$DATA_DIR" ]; then
  if ! _initdb_out="$(initdb -D "$DATA_DIR" -U postgres --auth=trust -E UTF8 2>&1)"; then
    if grep -qiE 'shmget|no space left on device' <<<"$_initdb_out"; then
      sweep_orphan_shm
      initdb -D "$DATA_DIR" -U postgres --auth=trust -E UTF8 >/dev/null
    else
      echo "$_initdb_out" >&2
      exit 1
    fi
  fi
fi

# unix_socket_directories는 짧은 고정 경로로 — scratchpad 등 긴 경로는 유닉스 소켓 경로
# 103바이트 상한(macOS)을 넘겨 기동 자체가 실패한다(story #3199 재현 시 실제로 걸림).
_start_pg() {
  pg_ctl -D "$DATA_DIR" -o "-p $PORT -c unix_socket_directories=/tmp" -l "$DATA_DIR/log.txt" start
}

if ! _start_pg; then
  if _shm_failure_signature "$DATA_DIR/log.txt"; then
    sweep_orphan_shm
    _start_pg
  else
    echo "disposable PG 기동 실패(shm 무관 사유) — $DATA_DIR/log.txt 확認하는" >&2
    exit 1
  fi
fi

echo "disposable PG ready — postgresql://postgres@127.0.0.1:$PORT/postgres (data=$DATA_DIR)"

if [ $# -gt 0 ]; then
  set +e
  "$@"
  code=$?
  set -e
  exit "$code"
fi

echo "Ctrl-C 또는 SIGTERM으로 종료하면 자동 stop(shm 반납)."
while true; do
  sleep 3600 &
  wait $!
done
