#!/usr/bin/env bash
# story #3199 — macOS 호스트 SysV shm(kern.sysv.shmmni=32, 로컬 기본값·시스템 전체 상한)이
# disposable PG initdb의 shmget으로 쉽게 saturate돼(우리 disposable PG들이 종료 trap 없이
# 죽으면서 세그를 반납 못 하고 누적) 반복 기동이 막히던 문제(미르코·저자 동형 재현)의 정리
# 루틴. `-c shared_memory_type=mmap`을 써도 안 풀렸던 이유: PG≥9.3은 shared_memory_type과
# 무관하게 클러스터당 SysV 세그 1개(소형 인터록용)를 항상 추가로 잡기 때문 — 그 1개가
# 32/32 saturation에 걸리면 mmap 여부와 무관하게 ENOSPC.
#
# 기동 전 이 호스트의 "죽은 disposable PG 잔재" shm 세그를 non-root ipcrm으로 스윕한다.
# 판별은 추정이 아니라 실물 대조: PG postmaster는 자기 SysV 세그의 key/shmid를
# postmaster.pid 7번째 줄에 스스로 기록하므로(PG≥10 표준 포맷, 같은 uid라 읽기 가능),
# 그걸로 살아있는 클러스터를 실물 확認해 제외하고 나머지만 지운다. IPC_RMID는 마지막
# detach 후 파괴라(POSIX 표준 동작) 혹시 살아있는 세그를 잘못 걸어도 attach 중인
# 프로세스는 안 죽는다 — 죽는 건 nattch=0 고아뿐.
#
# live 클러스터 탐색은 well-known 경로 추정(brew 경로 등)이 아니라 **실행 중인 postmaster
# 전수**로 한다 — 이 스토리의 발단 자체가 «두 저자 동형 재현»(병행 세션)이라, 다른 세션이
# 임의 data-dir에서 띄운 disposable PG도 실사용 경로다(페드루 QA 지적, PR#3616). `ps`로
# `postgres -D <dir>` 커맨드라인 전부를 찾아 그 dir들의 postmaster.pid를 전부 읽는다 —
# brew 경로는 이 일반 스캔에 자연히 흡수되어 더 이상 특례가 아니다.
# 못 잡는 것(선언): ⓐ다른 uid가 띄운 PG — 그 postmaster.pid를 못 읽지만, 같은 이유로
# 커널이 그 uid의 shm을 ipcrm으로부터도 막아주므로 안전(EPERM, 스윕에서 조용히 스킵).
# ⓑ같은 uid의 PG 아닌 SysV 사용자(다른 도구가 shm을 쓰는 경우) — 이건 진짜 미탐지 리스크.
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

sweep_orphan_shm() {
  local live_ids id skip found
  live_ids="$(_live_shmids)"
  ipcs -m 2>/dev/null | awk '/^m/ {print $2}' | while read -r id; do
    skip=0
    while read -r found; do
      [ -n "$found" ] && [ "$id" = "$found" ] && skip=1 && break
    done <<<"$live_ids"
    [ "$skip" = 1 ] && continue
    ipcrm -m "$id" >/dev/null 2>&1 || true
  done
}

sweep_orphan_shm

if [ ! -d "$DATA_DIR" ]; then
  initdb -D "$DATA_DIR" -U postgres --auth=trust -E UTF8 >/dev/null
fi

trap 'pg_ctl -D "$DATA_DIR" -m fast stop >/dev/null 2>&1 || true' EXIT INT TERM

# unix_socket_directories는 짧은 고정 경로로 — scratchpad 등 긴 경로는 유닉스 소켓 경로
# 103바이트 상한(macOS)을 넘겨 기동 자체가 실패한다(story #3199 재현 시 실제로 걸림).
pg_ctl -D "$DATA_DIR" -o "-p $PORT -c unix_socket_directories=/tmp" -l "$DATA_DIR/log.txt" start

echo "disposable PG ready — postgresql://postgres@127.0.0.1:$PORT/postgres (data=$DATA_DIR)"

if [ $# -gt 0 ]; then
  set +e
  "$@"
  code=$?
  set -e
  exit "$code"
fi

echo "Ctrl-C 또는 SIGTERM으로 종료하면 자동 stop(shm 반납)."
while true; do sleep 3600; done
