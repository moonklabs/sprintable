#!/usr/bin/env bash
# story #2659(2026-08-14) — 2026-08-14 fleet 전면 장애(공유 Data 볼륨 926Gi 100%) 사후 처방.
#
# 원인: 각 에이전트가 스토리마다 `git worktree add`로 격리 작업공간을 만들고(feedback-fresh
# -worktree-per-story 규율) `pnpm install`로 수백MB~GB의 node_modules를 채우는데, 머지 확定
# 후에도 그 worktree를 지우는 규율이 코드로 강제돼 있지 않았다 — "만든 쪽이 지운다"가 사람
# 기억에만 의존해 200개 넘게 쌓였다.
#
# 이 스크립트가 하는 일: 이미 머지·push 완료된(=더는 필요 없는) worktree만 골라 자동 회수한다.
#
# ⛔이 스크립트가 «절대 하지 않는» 것(안전 경계):
#   - dirty(커밋 안 된 변경 — 추적/미추적 불문) worktree는 절대 안 지운다.
#   - HEAD가 origin에 안 실린(push 안 된) worktree는 절대 안 지운다.
#   - 머지 확定(develop 조상 관계 OR merged PR)이 확인 안 되면 절대 안 지운다.
#   - 브랜치 자체는 안 지운다(worktree 디렉토리만 — node_modules가 진짜 용량범인이라 이거면
#     충분하고, 브랜치 삭제는 별도 판단 영역이라 이 스크립트 책임 밖).
#
# ⚠️오늘 실물로 걸린 함정 — «--branches 오스코프»: `git worktree list --branches` 같은 필터는
#   이 스크립트가 신뢰하는 안전기준이 아니다. 반드시 `git worktree list --porcelain`으로 각
#   worktree의 실제 HEAD sha를 얻어 «그 sha 자체»가 origin에 실렸는지(`git branch -r --contains
#   <sha>`) 확인한다 — 브랜치 이름이 같아도 로컬 HEAD가 origin보다 앞서 있으면(unpushed commit)
#   그 사실을 브랜치 존재 여부만으로는 못 잡는다.
#
# ⚠️squash-merge 함정 — `git merge-base --is-ancestor <branch> origin/develop`만으로는 GitHub
#   squash-merge된 브랜치를 UNMERGED로 오판한다(실측: feature/1cb4ef97-goal-form·
#   feature/5a9766eb-loop-board-ui 둘 다 `gh pr list --state merged`로는 MERGED인데
#   ancestor-check는 UNMERGED로 나옴 — merge-base 커밋 그래프에 없기 때문). 그래서 이 스크립트는
#   ancestor-check «또는» `gh pr list --state merged --head <branch>` 둘 중 하나라도 참이면
#   머지로 인정한다(OR 조건 — 어느 한쪽만 신뢰하지 않는다).
#
# 사용법:
#   scripts/reclaim-merged-worktrees.sh              # dry-run(기본) — 무엇을 지울지만 보고
#   scripts/reclaim-merged-worktrees.sh --apply       # 실제 삭제
#   scripts/reclaim-merged-worktrees.sh --apply --json  # 기계가 읽을 요약(JSON 한 줄)도 출력
#
# 환경변수:
#   RECLAIM_BASE_BRANCH   기본 develop — 머지 판정 기준 브랜치(origin/<이 값>).
#   RECLAIM_GH_TIMEOUT    기본 10(초) — gh pr list 1건당 타임아웃. gh 미설치/미인증이면
#                          이 단계를 건너뛰고 ancestor-check만 쓴다(과소회수 방향 — 안전 우선).

set -euo pipefail

APPLY=false
JSON_OUT=false
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --json) JSON_OUT=true ;;
    *) echo "unknown arg: $arg" >&2; exit 64 ;;
  esac
done

BASE_BRANCH="${RECLAIM_BASE_BRANCH:-develop}"
GH_TIMEOUT="${RECLAIM_GH_TIMEOUT:-10}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

git fetch origin "$BASE_BRANCH" --quiet 2>/dev/null || {
  echo "⚠️  origin/$BASE_BRANCH fetch 실패 — 네트워크 확인. 안전을 위해 중단한다." >&2
  exit 1
}

HAS_GH=false
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  HAS_GH=true
fi

# macOS 기본 유저랜드엔 GNU coreutils `timeout`이 없다(실측: 이 스크립트 첫 버전이 바로 이걸로
# gh 체크가 전부 조용히 무력화됐었다 — `timeout: command not found`가 non-zero exit이라
# is_pr_merged가 매번 "미확인"으로 새서, 정작 검증하려던 squash-merge 케이스가 통째로 안 잡힘).
# timeout/gtimeout(brew coreutils) 있으면 쓰고, 없으면 무제한으로 그냥 부른다 — gh CLI 자체
# HTTP 타임아웃이 있어 무한hang 위험은 낮지만 0은 아님(알려진 트레이드오프로 남긴다).
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="gtimeout"
fi

# gh pr list 결과를 캐시(같은 브랜치를 여러 worktree가 공유할 일은 드물지만, 반복 조회 비용 방지).
declare -A GH_MERGED_CACHE

is_pr_merged() {
  local branch="$1"
  if [ "$HAS_GH" != true ]; then return 1; fi
  if [ -n "${GH_MERGED_CACHE[$branch]+x}" ]; then
    [ "${GH_MERGED_CACHE[$branch]}" = "1" ]
    return $?
  fi
  local result
  local ok=false
  if [ -n "$TIMEOUT_BIN" ]; then
    if result=$("$TIMEOUT_BIN" "$GH_TIMEOUT" gh pr list --state merged --head "$branch" --json number --jq 'length' 2>/dev/null); then ok=true; fi
  else
    if result=$(gh pr list --state merged --head "$branch" --json number --jq 'length' 2>/dev/null); then ok=true; fi
  fi
  if [ "$ok" = true ] && [ "${result:-0}" -gt 0 ] 2>/dev/null; then
    GH_MERGED_CACHE[$branch]="1"; return 0
  fi
  GH_MERGED_CACHE[$branch]="0"; return 1
}

is_head_pushed() {
  local sha="$1"
  [ -n "$(git branch -r --contains "$sha" 2>/dev/null)" ]
}

is_ancestor_of_base() {
  local sha="$1"
  git merge-base --is-ancestor "$sha" "origin/$BASE_BRANCH" 2>/dev/null
}

is_worktree_clean() {
  local path="$1"
  [ -z "$(git -C "$path" status --porcelain 2>/dev/null)" ]
}

MAIN_WORKTREE="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"

RECLAIMED=()
KEPT=()

# git worktree list --porcelain: "worktree <path>" / "HEAD <sha>" / "branch refs/heads/<name>"
# (또는 "detached") 블록이 빈 줄로 구분된다. macOS 기본 awk는 다중문자 RS를 신뢰할 수 없게
# 다뤄서(레코드 사이 구분자가 씹히는 실측 버그) awk RS 트릭 대신 순수 bash 라인 파서로 각
# 블록을 누적·빈 줄에서 flush한다 — 이식성 우선.
process_worktree_record() {
  local wt_path="$1" wt_sha="$2" wt_branch_ref="$3"
  [ -z "$wt_path" ] && return
  [ "$wt_path" = "$MAIN_WORKTREE" ] && return

  if [ ! -d "$wt_path" ]; then
    return # prunable(이미 디스크에서 사라짐) — git worktree prune 몫, 이 스크립트 책임 밖.
  fi

  local branch="${wt_branch_ref#refs/heads/}"

  if [ -z "$wt_branch_ref" ]; then
    KEPT+=("$wt_path|detached HEAD — 수동 확인 필요")
    return
  fi

  if ! is_worktree_clean "$wt_path"; then
    KEPT+=("$wt_path|dirty(커밋 안 된 변경 존재)")
    return
  fi

  if ! is_head_pushed "$wt_sha"; then
    KEPT+=("$wt_path|HEAD($wt_sha) push 안 됨 — 로컬 유일 산출물일 수 있음")
    return
  fi

  local merged=false
  local merge_reason=""
  if is_ancestor_of_base "$wt_sha"; then
    merged=true; merge_reason="origin/$BASE_BRANCH 조상"
  elif is_pr_merged "$branch"; then
    merged=true; merge_reason="gh pr merged(squash 포함)"
  fi

  if [ "$merged" != true ]; then
    KEPT+=("$wt_path|미머지([$branch] ancestor 아님 + gh merged 아님)")
    return
  fi

  RECLAIMED+=("$wt_path|$branch|$merge_reason")
}

cur_path=""; cur_sha=""; cur_branch=""
while IFS= read -r line; do
  if [ -z "$line" ]; then
    process_worktree_record "$cur_path" "$cur_sha" "$cur_branch"
    cur_path=""; cur_sha=""; cur_branch=""
    continue
  fi
  case "$line" in
    "worktree "*) cur_path="${line#worktree }" ;;
    "HEAD "*) cur_sha="${line#HEAD }" ;;
    "branch "*) cur_branch="${line#branch }" ;;
  esac
done < <(git worktree list --porcelain; printf '\n') # 트레일링 빈줄로 마지막 블록도 flush 보장

echo "== reclaim-merged-worktrees $( [ "$APPLY" = true ] && echo "(APPLY)" || echo "(dry-run)") — base=origin/$BASE_BRANCH gh=$HAS_GH =="

for entry in "${KEPT[@]}"; do
  path="${entry%%|*}"; reason="${entry#*|}"
  echo "  KEEP     $path — $reason"
done

for entry in "${RECLAIMED[@]}"; do
  IFS='|' read -r path branch reason <<< "$entry"
  if [ "$APPLY" = true ]; then
    # AC3 — 일회 docker 컨테이너/볼륨이 worktree 회수 후에도 잔존하지 않게: 이 worktree에
    # docker-compose.yml이 있으면(실측: .qa-worktrees/* 391개 전부 해당 — Docker.raw 149G
    # 누적의 실체) worktree 삭제 «전에» 먼저 내린다. docker 데몬이 죽어있거나 이미 안 떠 있는
    # 스택이면 실패해도 무시(best-effort — worktree 회수 자체를 막지 않는다).
    if [ -f "$path/docker-compose.yml" ] && command -v docker >/dev/null 2>&1; then
      (cd "$path" && docker compose down --volumes --remove-orphans) >/dev/null 2>&1 || true
    fi
    if git worktree remove "$path" 2>/tmp/reclaim-worktree-err.$$; then
      echo "  RECLAIMED $path [$branch] — $reason"
    else
      echo "  FAILED   $path [$branch] — git worktree remove 실패: $(cat /tmp/reclaim-worktree-err.$$)"
      rm -f /tmp/reclaim-worktree-err.$$
    fi
  else
    echo "  WOULD-RECLAIM $path [$branch] — $reason"
  fi
done

if [ "$JSON_OUT" = true ]; then
  printf '{"apply":%s,"kept":%d,"reclaimed":%d}\n' "$APPLY" "${#KEPT[@]}" "${#RECLAIMED[@]}"
fi
