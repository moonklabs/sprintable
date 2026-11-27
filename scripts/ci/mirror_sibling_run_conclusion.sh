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
#
# PRECONDITION(페드루 PO CHANGES-1, 2026-09-21 명문화 요청) — 이 함수는 「같은 head_sha의
# run들 중 가장 오래된(run_id 최소) 것 = 진짜(non-edited) run」을 전제로 한다. run A가
# 사람 손으로 재실행(Re-run)되면 run_id는 그대로 유지되므로 이 전제는 안 깨지지만, 그
# 재실행으로 바뀐 결론을 이미 완주해 리포트를 마친 옛 edited-only run(run B)은 자동으로
# 다시 안 돈다 — run A를 재실행했으면 required 체크 최신화를 위해 run B도 수동으로 같이
# 재실행할 것(운영 규칙, PR #4482 본문 참고).
# story 5048 후속(CI 미러 «형제 대기» 고침 · PO 11-27 — 5991·5990에서 edited-only 실행의 미러가 failure로 닫혀 병합 관문을 막음):
#  ① «가장 오래된 형제 하나»를 시작 때 못 박지 않는다 — 그 run이 대상 잡을 아예 안 돌리는 run(5991의 실측: 형제 45931220688에는 그 이름의 잡이 없고 진짜 잡은 다른 형제에 있었다)이면 285초를 «안 보임»으로 기다리다 끝났다.
#     이제 매 폴링마다 같은 head_sha의 형제 run들을 다시 읽어, 대상 잡이 «보이는» 가장 오래된 형제를 골라 그 잡의 결론을 미러한다(run_id 최소 우선 전제는 그대로).
#  ② API 일시 오류(비-JSON · 빈 응답 · 한도 403 · 네트워크)는 `set -e`로 스크립트를 죽이지 않고 «아직 안 보임(레이스)»처럼 다음 폴링에서 다시 본다.
#     fail-closed는 그대로 — 확정 결론이 success가 아니거나 max-wait를 넘기면 exit 1. 「형제가 아직 도는 중」은 실패가 아니라 대기다.
#  ③ (codex 1회) «읽기 오류»와 «그 이름의 잡이 없음»을 구별한다 — 더 오래된 형제를 읽지 못한 폴링에서는 더 새 형제의 결론을 믿지 않고 다음 폴링을 기다린다(오래된 형제가 진짜 잡이면 그 결론이 우선).
find_sibling_run_ids() {
  # 이 run 자신을 뺀 같은 head_sha의 CI run id들(오름차순). API 오류면 빈 문자열(호출부가 레이스로 다룸).
  gh api "repos/${GH_REPO}/actions/runs?head_sha=${HEAD_SHA}&event=pull_request&per_page=50" \
    --jq "[.workflow_runs[] | select(.name == \"CI\") | select(.id != ${THIS_RUN_ID}) | .id] | sort | .[]" 2>/dev/null || true
}

# 대상 run의 jobs 목록에서 이름이 정확히 일치하는 잡의 {status, conclusion}을 한 줄 JSON으로 낸다.
#  · 잡이 «안 보임»(응답은 정상인데 그 이름이 없음 — 이 run은 그 잡을 안 돌림 · 레이스) → 빈 문자열
#  · API 오류(비-JSON · 한도 403 · 네트워크) → 정확히 `ERR`  ← 「안 보임」과 구별한다(codex 지적: 가장 오래된 형제의 오류를 «없음»으로 읽어
#    더 새 형제의 success를 미러하면, 진짜 잡이 빨간데도 초록으로 닫히는 fail-open이 됨).
find_job_state() {
  local run_id="$1" out
  if ! out="$(gh api "repos/${GH_REPO}/actions/runs/${run_id}/jobs?per_page=100" \
    --jq ".jobs[] | select(.name == \"${JOB_NAME}\") | {status, conclusion}" 2>/dev/null)"; then
    echo "ERR"
    return 0
  fi
  echo "$out"
}

echo "story #4099 — edited-only run(${THIS_RUN_ID}) — sha=${HEAD_SHA}의 진짜 run을 찾는 중..."
SIBLINGS="$(find_sibling_run_ids)"
if [ -z "$SIBLINGS" ]; then
  echo "::error::같은 head_sha(${HEAD_SHA})의 진짜(non-edited-only) run을 못 찾았습니다 — fail-closed."
  exit 1
fi
echo "형제 run 후보: $(echo "$SIBLINGS" | tr '\n' ' ')— '${JOB_NAME}' 잡이 보이는 가장 오래된 run의 결론을 기다립니다(최대 ${MAX_WAIT_SECONDS}초)."

ELAPSED=0
while true; do
  STATE_JSON=""
  PICKED=""
  # 매 폴링마다 형제 목록을 다시 읽는다(새 run이 생겼거나 앞선 읽기가 API 오류였을 수 있음).
  CURRENT="$(find_sibling_run_ids)"
  [ -n "$CURRENT" ] && SIBLINGS="$CURRENT"
  UNSURE=""
  for RID in $SIBLINGS; do
    S="$(find_job_state "$RID")"
    if [ "$S" = "ERR" ]; then
      # 이 형제를 읽지 못했다 — 더 오래된 형제의 «모름»을 건너뛰고 더 새 형제의 결론을 믿으면 안 된다. 다음 폴링에서 다시 본다.
      UNSURE="$RID"; break
    fi
    if [ -n "$S" ]; then STATE_JSON="$S"; PICKED="$RID"; break; fi
  done
  if [ -n "$STATE_JSON" ]; then
    STATUS="$(echo "$STATE_JSON" | jq -r '.status' 2>/dev/null || true)"
    CONCLUSION="$(echo "$STATE_JSON" | jq -r '.conclusion // empty' 2>/dev/null || true)"
    if [ "$STATUS" = "completed" ]; then
      echo "run ${PICKED}의 '${JOB_NAME}' 완주 — conclusion=${CONCLUSION}"
      if [ "$CONCLUSION" = "success" ]; then
        exit 0
      fi
      echo "::error::원본 잡 결론이 success가 아닙니다(${CONCLUSION}) — 미러도 실패로 닫습니다."
      exit 1
    fi
    echo "run ${PICKED}: 아직 진행 중(status=${STATUS:-?}) — ${POLL_INTERVAL_SECONDS}초 뒤 재확인 (경과 ${ELAPSED}s/${MAX_WAIT_SECONDS}s)"
  elif [ -n "$UNSURE" ]; then
    echo "run ${UNSURE}의 잡 목록을 못 읽음(API 일시 오류) — 더 새 형제로 넘어가지 않고 ${POLL_INTERVAL_SECONDS}초 뒤 재확인 (경과 ${ELAPSED}s/${MAX_WAIT_SECONDS}s)"
  else
    echo "형제 run 어디에도 '${JOB_NAME}' 잡이 아직 안 보임(레이스 · API 일시 오류 포함) — ${POLL_INTERVAL_SECONDS}초 뒤 재확인 (경과 ${ELAPSED}s/${MAX_WAIT_SECONDS}s)"
  fi

  if [ "$ELAPSED" -ge "$MAX_WAIT_SECONDS" ]; then
    echo "::error::${MAX_WAIT_SECONDS}초 안에 원본 잡이 완주하지 않았습니다 — fail-closed(타임아웃)."
    exit 1
  fi
  sleep "$POLL_INTERVAL_SECONDS"
  ELAPSED=$((ELAPSED + POLL_INTERVAL_SECONDS))
done
