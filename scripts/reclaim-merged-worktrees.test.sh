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

# 1) MERGED(ancestor) — develop에 fast-forward로 실제 merge된 브랜치, push 완료, clean.
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

echo "== dry-run =="
cd "$MAIN"
DRY_OUT="$(RECLAIM_BASE_BRANCH=develop "$SCRIPT")"
echo "$DRY_OUT"

echo
echo "-- dry-run 판정 검증 --"
assert_contains "$DRY_OUT" "WOULD-RECLAIM $(wt ancestor-merged)" "ancestor-merged → WOULD-RECLAIM"
assert_contains "$DRY_OUT" "WOULD-RECLAIM $(wt squash-merged)" "squash-merged(gh만 앎) → WOULD-RECLAIM"
assert_contains "$DRY_OUT" "KEEP     $(wt dirty)" "dirty → KEEP"
assert_contains "$DRY_OUT" "KEEP     $(wt unpushed)" "unpushed HEAD → KEEP"
assert_contains "$DRY_OUT" "KEEP     $(wt unmerged)" "unmerged → KEEP"

echo
echo "== --apply =="
APPLY_OUT="$(RECLAIM_BASE_BRANCH=develop "$SCRIPT" --apply)"
echo "$APPLY_OUT"

echo
echo "-- 실제 디스크 상태 검증(AC4 음성대조: 진행중 worktree는 절대 안 지워짐) --"
assert_not_exists "$(wt ancestor-merged)" "ancestor-merged"
assert_not_exists "$(wt squash-merged)" "squash-merged"
assert_exists "$(wt dirty)" "dirty"
assert_exists "$(wt unpushed)" "unpushed"
assert_exists "$(wt unmerged)" "unmerged"

echo
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASS"
  exit 0
else
  echo "FAILURES ABOVE"
  exit 1
fi
