#!/usr/bin/env bash
# story #2659 AC1+AC4 — reclaim-merged-worktrees.sh 안전검사 실측 스모크테스트.
# 진짜 sprintable 레포를 건드리지 않고 /tmp에 던지는 합성(synthetic) git 원격+worktree
# 시나리오로 KEEP/RECLAIM 판정을 잰다. AC4(과잉살상 음성대조)의 «절대 안 지워짐» 요구를
# narrative가 아니라 실행 결과로 고정한다.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/reclaim-merged-worktrees.sh"

WORK="$(mktemp -d)"
WORK="$(cd "$WORK" && pwd -P)" # macOS: /var → /private/var 심볼릭 링크. git이 리포트하는 실제
                                # worktree 경로는 이미 resolve된 형태라 $WORK도 맞춰야 문자열이 맞는다.
trap 'rm -rf "$WORK"' EXIT

FAIL=0
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "  ok   $label"
  else
    echo "  FAIL $label — expected to find: $needle"
    FAIL=1
  fi
}
assert_exists() {
  [ -d "$1" ] && echo "  ok   $2 (still exists)" || { echo "  FAIL $2 (should still exist, got removed!)"; FAIL=1; }
}
assert_not_exists() {
  [ ! -d "$1" ] && echo "  ok   $2 (reclaimed)" || { echo "  FAIL $2 (should have been removed, still exists)"; FAIL=1; }
}

# ── 합성 origin + main 체크아웃 준비 ────────────────────────────────────────
ORIGIN="$WORK/origin.git"
git init --bare -q "$ORIGIN"

MAIN="$WORK/main"
git clone -q "$ORIGIN" "$MAIN"
git -C "$MAIN" config user.email "test@example.com"
git -C "$MAIN" config user.name "test"
git -C "$MAIN" checkout -q -b develop
echo "root" > "$MAIN/f.txt"
git -C "$MAIN" add f.txt
git -C "$MAIN" commit -q -m "root"
git -C "$MAIN" push -q -u origin develop

# 실제 스크립트가 origin에서 안전 판정에 쓰는 '가짜 gh' — GitHub 없이도 squash-merge
# 경로(merge-base ancestor가 아니지만 실제로는 PR이 merged)를 재현한다.
FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/gh" <<'GHSTUB'
#!/usr/bin/env bash
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  # --head 뒤 인자로 브랜치명을 받아, squash-merged-branch 만 merged로 응답한다.
  branch=""
  prev=""
  for a in "$@"; do
    if [ "$prev" = "--head" ]; then branch="$a"; fi
    prev="$a"
  done
  if [ "$branch" = "squash-merged-branch" ]; then echo 1; else echo 0; fi
  exit 0
fi
exit 1
GHSTUB
chmod +x "$FAKE_BIN/gh"
export PATH="$FAKE_BIN:$PATH"

wt() { echo "$WORK/wt-$1"; }

# 1) story #4137 CHANGES-1(PO 확定 2026-09-22) — GitHub PR 없이 로컬 no-ff 머지 후 push된
#    브랜치. 이 조직 워크플로우(PR→리뷰→QA→머지)가 금지하는 경로라 실사용 시나리오가 아니다
#    — 실측: no-ff 머지는 브랜치 자신의 ref를 안 움직여 머지된 브랜치의 tip도 "현재
#    origin/develop 기준 ahead 0"이 되는 게 그래프 위상상 불가피하다(ancestor-check
#    참 + ahead-count 0). 이 위상은 story #4137이 막으려는 "커밋 0인 새 브랜치" 버그와
#    구조적으로 동일해 pure-git-topology로는 못 가른다 — 그래서 이제 KEEP(판별 불가,
#    과소회수가 안전). 실 머지 경로(gh PR squash)는 시나리오 2가 그대로 커버한다.
git -C "$MAIN" checkout -q -b ancestor-merged-branch
echo "a" >> "$MAIN/f.txt"; git -C "$MAIN" commit -q -am "a"
git -C "$MAIN" checkout -q develop
git -C "$MAIN" merge -q --no-ff ancestor-merged-branch -m "merge a"
git -C "$MAIN" push -q origin develop
git -C "$MAIN" push -q origin ancestor-merged-branch
git -C "$MAIN" worktree add -q "$(wt ancestor-merged)" ancestor-merged-branch

# 2) MERGED(squash — gh만 안다, merge-base ancestor 아님) — develop에 별도 커밋으로 흡수됐다고
#    가정(squash-merge 시뮬레이션: 브랜치 자체는 develop 조상관계가 아님).
git -C "$MAIN" checkout -q -b squash-merged-branch
echo "b" >> "$MAIN/f.txt"; git -C "$MAIN" commit -q -am "b (will be squashed)"
git -C "$MAIN" push -q origin squash-merged-branch
git -C "$MAIN" checkout -q develop
git -C "$MAIN" worktree add -q "$(wt squash-merged)" squash-merged-branch

# 3) DIRTY — 커밋 안 된 변경이 있으면 그 자체로 즉시 KEEP(머지/push 상태와 무관하게 최우선
#    안전검사). 별도 로컬 브랜치로 떠서 worktree #1(ancestor-merged-branch)과 브랜치 충돌 없게.
git -C "$MAIN" worktree add -q -b dirty-branch "$(wt dirty)" ancestor-merged-branch
echo "uncommitted" >> "$(wt dirty)/f.txt"

# 4) UNPUSHED HEAD — 로컬에서 한 커밋 더 나갔지만 origin엔 없다(로컬 유일 산출물).
git -C "$MAIN" checkout -q -b unpushed-branch
echo "c" >> "$MAIN/f.txt"; git -C "$MAIN" commit -q -am "c"
git -C "$MAIN" push -q origin unpushed-branch
git -C "$MAIN" checkout -q develop
git -C "$MAIN" worktree add -q "$(wt unpushed)" unpushed-branch
echo "d local only" >> "$(wt unpushed)/f.txt"
git -C "$(wt unpushed)" commit -q -am "d (never pushed)"

# 5) UNMERGED(그냥 진행중) — push는 됐지만 develop에도 안 들어갔고 gh도 모른다.
git -C "$MAIN" checkout -q -b unmerged-branch
echo "e" >> "$MAIN/f.txt"; git -C "$MAIN" commit -q -am "e"
git -C "$MAIN" push -q origin unmerged-branch
git -C "$MAIN" checkout -q develop
git -C "$MAIN" worktree add -q "$(wt unmerged)" unmerged-branch

# 6) story #4137 AC1 핵심 — 커밋 0인 새 브랜치(방금 `git worktree add -b <branch> <base>`로
#    뜬 작업 시작 前 워크트리, 실사고 재현). 새 브랜치 자체를 push하지 않는다(실사고와 동형
#    — sha가 origin/develop 자체에 이미 있어 is_head_pushed는 그 이유만으로 참이 된다,
#    이 브랜치 고유의 push가 없어도).
git -C "$MAIN" worktree add -q -b fresh-zero-commit-branch "$(wt fresh)" develop

echo "== dry-run =="
cd "$MAIN"
DRY_OUT="$(RECLAIM_BASE_BRANCH=develop "$SCRIPT")"
echo "$DRY_OUT"

echo
echo "-- dry-run 판정 검증 --"
assert_contains "$DRY_OUT" "KEEP     $(wt ancestor-merged) — 머지 확定 불가: 조상이나 ahead 0·머지 PR 없음" "ancestor-merged(PR 없는 no-ff, 지원 경로 아님) → KEEP"
assert_contains "$DRY_OUT" "WOULD-RECLAIM $(wt squash-merged)" "squash-merged(gh만 앎) → WOULD-RECLAIM"
assert_contains "$DRY_OUT" "KEEP     $(wt dirty)" "dirty → KEEP"
assert_contains "$DRY_OUT" "KEEP     $(wt unpushed)" "unpushed HEAD → KEEP"
assert_contains "$DRY_OUT" "KEEP     $(wt unmerged)" "unmerged → KEEP"
assert_contains "$DRY_OUT" "KEEP     $(wt fresh) — 머지 확定 불가: 조상이나 ahead 0·머지 PR 없음" "fresh-zero-commit(story #4137 AC1 핵심 실사고 재현) → KEEP"

echo
echo "== --apply =="
APPLY_OUT="$(RECLAIM_BASE_BRANCH=develop "$SCRIPT" --apply)"
echo "$APPLY_OUT"

echo
echo "-- 실제 디스크 상태 검증(AC4 음성대조: 진행중 worktree는 절대 안 지워짐) --"
assert_exists "$(wt ancestor-merged)" "ancestor-merged(판별 불가 → KEEP, 지워지지 않아야 함)"
assert_not_exists "$(wt squash-merged)" "squash-merged"
assert_exists "$(wt dirty)" "dirty"
assert_exists "$(wt unpushed)" "unpushed"
assert_exists "$(wt unmerged)" "unmerged"
assert_exists "$(wt fresh)" "fresh-zero-commit(AC1 pin — 회수되면 실사고 재발)"

echo
echo "== 실 스케일 SIGPIPE 회귀가드(PO 첫 dry-run 실물 발견, 등록 264개 레포에서 exit=141) =="
# 파이프 버퍼(보통 64KB)를 넘는 `git worktree list --porcelain` 출력을 만들어야 재현된다 —
# 합성 시나리오 5개(worktree 소수)로는 구조적으로 못 잡는다. detached worktree는 브랜치
# 배타성이 없어(같은 커밋을 여러 worktree가 동시에 가리켜도 됨) 빠르게 대량 생성 가능.
STRESS_COUNT=450
for i in $(seq 1 "$STRESS_COUNT"); do
  git -C "$MAIN" worktree add -q --detach "$WORK/stress-$i" develop >/dev/null 2>&1
done

STRESS_PORCELAIN_BYTES="$(git -C "$MAIN" worktree list --porcelain | wc -c | tr -d ' ')"
echo "  porcelain 출력 크기: ${STRESS_PORCELAIN_BYTES} bytes(생성 ${STRESS_COUNT}개, 목표 >65536)"

if STRESS_OUT="$(cd "$MAIN" && RECLAIM_BASE_BRANCH=develop "$SCRIPT" 2>&1)"; then
  STRESS_EC=0
else
  STRESS_EC=$?
fi

if [ "$STRESS_EC" -eq 0 ]; then
  echo "  ok   대량 worktree(${STRESS_COUNT}개, ${STRESS_PORCELAIN_BYTES}B) dry-run이 SIGPIPE 없이 완주(exit=0)"
else
  echo "  FAIL 대량 worktree dry-run이 exit=${STRESS_EC}로 죽었다(141=SIGPIPE 재발)"
  echo "$STRESS_OUT" | head -5
  FAIL=1
fi

if [[ "$STRESS_OUT" != *"KEEP     $MAIN"* ]] && [[ "$STRESS_OUT" != *"WOULD-RECLAIM $MAIN"* ]]; then
  echo "  ok   MAIN_WORKTREE($MAIN) 자신은 KEEP/RECLAIM 목록에 안 나타난다(자기 자신 제외 로직 건재)"
else
  echo "  FAIL MAIN_WORKTREE가 회수 후보 목록에 나타났다 — 자기 자신 삭제 위험"
  FAIL=1
fi

DETACHED_COUNT="$(printf '%s\n' "$STRESS_OUT" | grep -c "detached HEAD" || true)"
if [ "$DETACHED_COUNT" -ge "$STRESS_COUNT" ]; then
  echo "  ok   detached worktree ${DETACHED_COUNT}개 전부 KEEP(수동확인) 분류됨"
else
  echo "  FAIL detached worktree가 ${DETACHED_COUNT}개만 KEEP으로 잡혔다(기대 >= ${STRESS_COUNT} — 파싱 누락 의심)"
  FAIL=1
fi

echo
echo "== story #4137 AC3 — bash 3.2(launchd 실사고 재현) 버전가드 =="
# launchd plist가 /bin/bash(macOS 시스템 bash, 3.2)로 스크립트를 돌려 `declare -A`에서
# 원인불명 exit 2로 매일 04:30 조용히 죽던 실사고(cron/reclaim.log 실측)의 재현·고정.
# /bin/bash 3.2가 실제로 이 macOS에 존재한다는 전제 — 없으면 이 검증 자체가 무의미하므로
# 스킵(FAIL 아님, 이 머신의 환경 한계).
BASH32_MAJOR=99
[ -x /bin/bash ] && BASH32_MAJOR="$(/bin/bash -c 'echo ${BASH_VERSINFO[0]}' 2>/dev/null || echo 99)"

if [ "$BASH32_MAJOR" -lt 4 ]; then
  OLDBASH_ERR="$WORK/oldbash-stderr.txt"
  OLDBASH_EXIT=0
  /bin/bash "$SCRIPT" --dry-run >/dev/null 2>"$OLDBASH_ERR" || OLDBASH_EXIT=$?
  OLDBASH_OUT="$(cat "$OLDBASH_ERR")"

  if [ "$OLDBASH_EXIT" -eq 65 ]; then
    echo "  ok   /bin/bash(3.2) 실행 → exit 65"
  else
    echo "  FAIL /bin/bash(3.2) 실행 → exit ${OLDBASH_EXIT}(기대 65)"
    FAIL=1
  fi

  assert_contains "$OLDBASH_OUT" "bash 4+ 필요" "stderr에 원인 메시지 포함"

  if [[ "$OLDBASH_OUT" == *"declare"* ]]; then
    echo "  FAIL stderr에 declare 관련 에러가 섞여있다(가드가 declare -A보다 먼저 안 걸렸다) — $OLDBASH_OUT"
    FAIL=1
  else
    echo "  ok   stderr에 declare 관련 에러 없음(가드가 declare -A 도달 前에 먼저 죽음)"
  fi
else
  echo "  skip /bin/bash가 이 머신에서 3.2 미만이 아니거나 실행 불가 — 이 검증은 이 환경에서 의미 없음"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASS"
  exit 0
else
  echo "FAILURES ABOVE"
  exit 1
fi
