#!/usr/bin/env bash
# story #4319(PO 2026-09-25 16:01Z · AC5) — 정지 감지기(run-with-stall-detection.sh)가 명령을 죽이기 **전에**, 무엇을 기다리다
# 멈췄는지 가를 증거를 잡 로그에 남긴다. 원인을 모른 채 «다시 돌리니 됨»으로 넘어가지 않게(두 번 · 서로 다른 파일 · 서로 다른
# 시점에 멈춤 — 4258 첫 테스트 전 · 4177 통과 점 4개 뒤).
#
# 사용법: stall-evidence.sh <root_pid> <evidence_dir>
#   ① DB: 같은 Postgres의 클라이언트 연결 전부(`pg_stat_activity` — 상태 · 대기 이벤트 · 막는 pid · 트랜잭션/쿼리 나이 · 쿼리)와
#      잠금(`pg_locks` — 못 받은 것 먼저 · 쥔 쪽).
#   ② pytest: <root_pid> 아래의 pytest 프로세스에 SIGUSR1(모든 스레드 스택 · faulthandler) · SIGUSR2(asyncio 태스크 스택)를
#      보내고, conftest가 <evidence_dir>에 쓴 덤프를 로그로 옮긴다(pytest 출력 가로채기 밖 · 파일로 쓴다 — conftest 참조).
# 이 스크립트는 판정을 바꾸지 않는다(항상 0) — 증거 수집 실패도 로그에 남기고 넘어간다.
set -uo pipefail

ROOT_PID="${1:?root pid}"
EVIDENCE_DIR="${2:?evidence dir}"
PG_HOST="${STALL_EVIDENCE_PGHOST:-localhost}"
PG_USER="${STALL_EVIDENCE_PGUSER:-sprintable}"
PG_DB="${STALL_EVIDENCE_PGDATABASE:-postgres}"
DUMP_WAIT_SEC="${STALL_EVIDENCE_DUMP_WAIT_SEC:-5}"

echo "::group::STALL evidence(story #4319) — $(date -u +%FT%TZ) · root pid ${ROOT_PID}" >&2

echo "── ① pg_stat_activity(클라이언트 연결 · 막는 pid 포함) ──" >&2
PGPASSWORD="${PGPASSWORD:-sprintable}" psql -h "$PG_HOST" -U "$PG_USER" -d "$PG_DB" -X -P pager=off -c "
SELECT pid, datname, application_name AS app, state, wait_event_type AS wait_type, wait_event,
       pg_blocking_pids(pid) AS blocked_by,
       date_trunc('second', now() - xact_start) AS xact_age,
       date_trunc('second', now() - query_start) AS query_age,
       left(regexp_replace(query, '\s+', ' ', 'g'), 300) AS query
FROM pg_stat_activity
WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()
ORDER BY xact_start NULLS LAST, pid;" >&2 2>&1 || echo "(pg_stat_activity 조회 실패 — 위 오류 참고)" >&2

echo "── ① pg_locks(못 받은 잠금 먼저) ──" >&2
PGPASSWORD="${PGPASSWORD:-sprintable}" psql -h "$PG_HOST" -U "$PG_USER" -d "$PG_DB" -X -P pager=off -c "
SELECT l.pid, l.granted, l.mode, l.locktype,
       d.datname,
       CASE WHEN l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
            THEN l.relation::regclass::text ELSE l.relation::text END AS relation,
       l.transactionid, l.virtualxid, a.state,
       left(regexp_replace(a.query, '\s+', ' ', 'g'), 160) AS query
FROM pg_locks l
LEFT JOIN pg_stat_activity a ON a.pid = l.pid
LEFT JOIN pg_database d ON d.oid = l.database
WHERE l.pid IS DISTINCT FROM pg_backend_pid()
ORDER BY l.granted, l.pid, l.locktype;" >&2 2>&1 || echo "(pg_locks 조회 실패 — 위 오류 참고)" >&2

# <root_pid>의 자손 중 pytest 프로세스(uv run → python -m pytest 등 층이 여럿).
descendants() {
  local parent="$1" child
  for child in $(ps -eo pid=,ppid= | awk -v p="$parent" '$2 == p { print $1 }'); do
    echo "$child"
    descendants "$child"
  done
}
pytest_pids=()
for pid in $(descendants "$ROOT_PID"); do
  cmd=$(ps -o command= -p "$pid" 2>/dev/null) || continue
  exe=$(basename "${cmd%% *}" | tr '[:upper:]' '[:lower:]')  # macOS 프레임워크 빌드는 «Python»
  # 실행 파일이 python 또는 pytest인 프로세스만 — 런처(`uv run pytest …`)는 명령줄에 pytest가 있어도 빼야 한다: SIGUSR1의 기본
  # 동작은 종료라 런처가 죽으면 정지 판의 종료 코드가 124(STALL)가 아니라 신호 종료로 바뀌어 «멈춤» 판정이 사라진다.
  if [[ "$cmd" == *pytest* ]] && [[ "$exe" == python* || "$exe" == pytest ]]; then
    pytest_pids+=("$pid")
  fi
done

echo "── ② pytest 프로세스: ${pytest_pids[*]:-(없음)} ──" >&2
for pid in "${pytest_pids[@]+"${pytest_pids[@]}"}"; do
  kill -USR1 "$pid" 2>/dev/null || echo "(pid $pid SIGUSR1 실패)" >&2
  kill -USR2 "$pid" 2>/dev/null || echo "(pid $pid SIGUSR2 실패)" >&2
done
if [ "${#pytest_pids[@]}" -gt 0 ]; then
  sleep "$DUMP_WAIT_SEC"
fi
shopt -s nullglob
# 방금 신호를 보낸 프로세스의 덤프만 — 샤드 하나가 증거 폴더를 같이 쓰고, 파일마다 pytest가 시작할 때 빈 덤프 파일을 연다.
dumps=()
for pid in "${pytest_pids[@]+"${pytest_pids[@]}"}"; do
  dumps+=("$EVIDENCE_DIR"/pytest-"$pid"-*.txt)
done
if [ "${#dumps[@]}" -eq 0 ]; then
  echo "(스택 덤프 파일 없음 — conftest의 STALL_EVIDENCE_DIR 등록이 안 됐거나 프로세스가 신호를 못 받음)" >&2
fi
for dump in "${dumps[@]}"; do
  echo "── ② $(basename "$dump") ──" >&2
  cat "$dump" >&2
done
echo "::endgroup::" >&2
exit 0
