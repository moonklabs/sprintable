#!/usr/bin/env bash
# story #4099(CI·머지 안전, 페드루 PO 확定 2026-09-21) — edited-only(PR 본문/제목 편집,
# base 무변) run은 지금까지(story #3929) required 잡을 job-level `if:`로 skip시켰다.
# GitHub Actions는 "job이 자기 if:로 skip되면 그 체크는 Success"로 보고한다(트러블슈팅
# 문서 확認) — 그래서 같은 head SHA의 «진짜»(synchronize 등) run이 아직 도는 중에도
# edited-only run의 skip이 즉시 초록을 내 required 체크를 채워버렸다(실사고: PR #4473
# head 695390519, run A=in_progress인데 run B=edited-only가 7분 만에 skip/success로
# 닫혀 머지가 열림). 이 스크립트는 skip 대신 「같은 SHA의 진짜 run이 완주할 때까지
# 기다렸다가 그 run의 같은 이름 잡 결론을 그대로 미러」한다 — 폴링 중엔 이 잡도
# in_progress로 정직하게 남아(스킵이 아니라 실제로 도는 잡이므로) required 체크가
# 조기에 초록이 되지 않는다. 무거운 실제 작업(pytest·lint 등)은 0 — 이 스크립트만 돈다.
#
# 사용법:
#   mirror_sibling_run_conclusion.sh --job-name "<잡 표시 이름>" --head-sha <sha> \
#     --this-run-id <이 run의 id> [--poll-interval-seconds N(기본 15)] \
#     [--max-wait-seconds N(기본 1200)]
#
# 종료 코드: 0 = 미러 대상 잡의 결론이 success. 1 = 그 외 전부(실패·취소·진짜 run을
#   못 찾음·대상 잡을 못 찾음·타임아웃 — fail-closed, "모르면 통과시키지 않는다").
#
# 환경변수: GH_TOKEN·GH_REPO(gh CLI 표준 — ci.yml이 이미 다른 잡에서 쓰는 관례 그대로,
#   scripts/ci_alembic_sibling_pr_collision_check.py 옆자리 참고).
set -euo pipefail

JOB_NAME=""
HEAD_SHA=""
THIS_RUN_ID=""
POLL_INTERVAL_SECONDS=15
MAX_WAIT_SECONDS=1200

while [ $# -gt 0 ]; do
  case "$1" in
    --job-name) JOB_NAME="$2"; shift 2 ;;
    --head-sha) HEAD_SHA="$2"; shift 2 ;;
    --this-run-id) THIS_RUN_ID="$2"; shift 2 ;;
    --poll-interval-seconds) POLL_INTERVAL_SECONDS="$2"; shift 2 ;;
    --max-wait-seconds) MAX_WAIT_SECONDS="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$JOB_NAME" ] || [ -z "$HEAD_SHA" ] || [ -z "$THIS_RUN_ID" ]; then
  echo "usage: mirror_sibling_run_conclusion.sh --job-name <name> --head-sha <sha> --this-run-id <id> [--poll-interval-seconds N] [--max-wait-seconds N]" >&2
  exit 1
fi

: "${GH_REPO:?GH_REPO env var required (owner/repo)}"

# story #4099 — 같은 head_sha에 여러 run이 있을 수 있다(원래 push/synchronize run 1개 +
# 그 뒤 title/body를 여러 번 고치면 edited-only run이 더 생김). run_id는 단조증가하고
# title/body 편집은 새 커밋을 안 만들므로(같은 SHA를 유지) 「이 run 자신을 뺀 나머지 중
# run_id가 가장 작은 것」이 언제나 최초 트리거(진짜 run)다 — 이후 생긴 edited-only run은
# 전부 그보다 늦게(큰 id로) 생긴다.
find_sibling_run_id() {
  gh api "repos/${GH_REPO}/actions/runs?head_sha=${HEAD_SHA}&event=pull_request&per_page=50" \
    --jq "[.workflow_runs[] | select(.name == \"CI\") | select(.id != ${THIS_RUN_ID})] | sort_by(.id) | .[0].id // empty"
}

# 대상 run의 jobs 목록에서 이름이 정확히 일치하는 잡의 {status, conclusion}을 한 줄
# JSON으로 낸다 — 아직 그 이름의 잡이 안 보이면(run은 있으나 job 목록이 아직 안 채워진
# 레이스) 빈 문자열.
find_job_state() {
  local run_id="$1"
  gh api "repos/${GH_REPO}/actions/runs/${run_id}/jobs?per_page=100" \
    --jq ".jobs[] | select(.name == \"${JOB_NAME}\") | {status, conclusion}"
}

echo "story #4099 — edited-only run(${THIS_RUN_ID}) — sha=${HEAD_SHA}의 진짜 run을 찾는 중..."
SIBLING_RUN_ID="$(find_sibling_run_id)"
if [ -z "$SIBLING_RUN_ID" ]; then
  echo "::error::같은 head_sha(${HEAD_SHA})의 진짜(non-edited-only) run을 못 찾았습니다 — fail-closed."
  exit 1
fi
echo "진짜 run = ${SIBLING_RUN_ID} — 그 run의 '${JOB_NAME}' 잡 결론을 기다리는 중(최대 ${MAX_WAIT_SECONDS}초)..."

ELAPSED=0
while true; do
  STATE_JSON="$(find_job_state "$SIBLING_RUN_ID")"
  if [ -n "$STATE_JSON" ]; then
    STATUS="$(echo "$STATE_JSON" | jq -r '.status')"
    CONCLUSION="$(echo "$STATE_JSON" | jq -r '.conclusion // empty')"
    if [ "$STATUS" = "completed" ]; then
      echo "run ${SIBLING_RUN_ID}의 '${JOB_NAME}' 완주 — conclusion=${CONCLUSION}"
      if [ "$CONCLUSION" = "success" ]; then
        exit 0
      fi
      echo "::error::원본 잡 결론이 success가 아닙니다(${CONCLUSION}) — 미러도 실패로 닫습니다."
      exit 1
    fi
    echo "아직 진행 중(status=${STATUS}) — ${POLL_INTERVAL_SECONDS}초 뒤 재확인 (경과 ${ELAPSED}s/${MAX_WAIT_SECONDS}s)"
  else
    echo "run ${SIBLING_RUN_ID}에 '${JOB_NAME}' 잡이 아직 안 보임(레이스 가능) — ${POLL_INTERVAL_SECONDS}초 뒤 재확인 (경과 ${ELAPSED}s/${MAX_WAIT_SECONDS}s)"
  fi

  if [ "$ELAPSED" -ge "$MAX_WAIT_SECONDS" ]; then
    echo "::error::${MAX_WAIT_SECONDS}초 안에 원본 잡이 완주하지 않았습니다 — fail-closed(타임아웃)."
    exit 1
  fi
  sleep "$POLL_INTERVAL_SECONDS"
  ELAPSED=$((ELAPSED + POLL_INTERVAL_SECONDS))
done
