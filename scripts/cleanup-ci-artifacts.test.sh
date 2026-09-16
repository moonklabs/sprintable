#!/usr/bin/env bash
# story #3864 AC2 — cleanup-ci-artifacts.sh 필터 안전검사 실측 스모크테스트.
# 진짜 GitHub API를 건드리지 않고 가짜 `gh` 스텁이 합성 artifact 목록을 돌려준다.
# reclaim-merged-worktrees.test.sh와 동형 원칙: 실물 대신 통제된 합성 데이터로
# «지워야 할 것만 지운다 / 손대면 안 되는 건 절대 안 지운다»를 실행 결과로 고정한다.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/cleanup-ci-artifacts.sh"

WORK="$(mktemp -d)"
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
assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "  ok   $label"
  else
    echo "  FAIL $label — must NOT find: $needle"
    FAIL=1
  fi
}

# ── 합성 artifact 목록 ───────────────────────────────────────────────────────
# now - 30일(old, 삭제 대상) · now - 1일(recent, cutoff 안쪽 — 안 지워짐) ·
# 다른 이름(old지만 name 불일치 — 안 지워짐) · 이미 만료(expired — 안 지워짐).
# story #3890 — shard-durations-2·vitest-duration-summary도 기본 목록에 추가됐으므로
# 「다른 이름」 음성대조는 그 둘과 무관한 dockerbuild-*(빌드 캐시, 여전히 스코프 밖)로 교체.
if date -v-1d >/dev/null 2>&1; then
  OLD_DATE="$(date -u -v-30d +%Y-%m-%dT%H:%M:%SZ)"
  RECENT_DATE="$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ)"
else
  OLD_DATE="$(date -u -d '-30 days' +%Y-%m-%dT%H:%M:%SZ)"
  RECENT_DATE="$(date -u -d '-1 days' +%Y-%m-%dT%H:%M:%SZ)"
fi

FIXTURE="$WORK/artifacts.json"
cat > "$FIXTURE" <<JSON
{
  "artifacts": [
    {"id": 101, "name": "playwright-report", "expired": false, "created_at": "$OLD_DATE", "size_in_bytes": 1000},
    {"id": 102, "name": "playwright-report", "expired": false, "created_at": "$OLD_DATE", "size_in_bytes": 2000},
    {"id": 103, "name": "playwright-report", "expired": false, "created_at": "$RECENT_DATE", "size_in_bytes": 3000},
    {"id": 104, "name": "dockerbuild-abc123", "expired": false, "created_at": "$OLD_DATE", "size_in_bytes": 4000},
    {"id": 105, "name": "playwright-report", "expired": true, "created_at": "$OLD_DATE", "size_in_bytes": 5000},
    {"id": 106, "name": "lighthouse-results", "expired": false, "created_at": "$OLD_DATE", "size_in_bytes": 6000},
    {"id": 107, "name": "shard-durations-2", "expired": false, "created_at": "$OLD_DATE", "size_in_bytes": 7000},
    {"id": 108, "name": "vitest-duration-summary", "expired": false, "created_at": "$OLD_DATE", "size_in_bytes": 8000}
  ]
}
JSON

DELETE_LOG="$WORK/deleted-ids.log"
: > "$DELETE_LOG"

FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/gh" <<GHSTUB
#!/usr/bin/env bash
if [ "\$1" = "api" ] && [ "\$2" = "--paginate" ]; then
  cat "$FIXTURE" | jq -c '.artifacts[]'
  exit 0
fi
if [ "\$1" = "api" ] && [ "\$2" = "-X" ] && [ "\$3" = "DELETE" ]; then
  id="\${4##*/}"
  echo "\$id" >> "$DELETE_LOG"
  exit 0
fi
echo "unexpected gh invocation: \$*" >&2
exit 1
GHSTUB
chmod +x "$FAKE_BIN/gh"

run_script() {
  PATH="$FAKE_BIN:$PATH" "$SCRIPT" "$@"
}

echo "── dry-run(기본, story #3890 확장 목록) ──"
DRYRUN_OUT="$(run_script 2>&1)"
assert_contains "$DRYRUN_OUT" "id=101" "old playwright-report(101) 대상에 포함"
assert_contains "$DRYRUN_OUT" "id=102" "old playwright-report(102) 대상에 포함"
assert_contains "$DRYRUN_OUT" "id=106" "old lighthouse-results(106) 대상에 포함(다중 이름 필터)"
assert_contains "$DRYRUN_OUT" "id=107" "old shard-durations-2(107) 대상에 포함(story #3890 확장)"
assert_contains "$DRYRUN_OUT" "id=108" "old vitest-duration-summary(108) 대상에 포함(story #3890 확장)"
assert_not_contains "$DRYRUN_OUT" "id=103" "recent playwright-report(103, cutoff 안쪽) 대상 제외"
assert_not_contains "$DRYRUN_OUT" "id=104" "다른 이름(dockerbuild-abc123, 104) 대상 제외 — name 정확일치 필터"
assert_not_contains "$DRYRUN_OUT" "id=105" "이미 만료된 artifact(105) 대상 제외"
assert_contains "$DRYRUN_OUT" "삭제 대상 합계: 5건" "대상 count=5 정확 집계"
assert_contains "$DRYRUN_OUT" "playwright-report: 2건" "이름별 분류 — playwright-report 2건"
assert_contains "$DRYRUN_OUT" "lighthouse-results: 1건" "이름별 분류 — lighthouse-results 1건"
assert_contains "$DRYRUN_OUT" "shard-durations-2: 1건" "이름별 분류 — shard-durations-2 1건"
assert_contains "$DRYRUN_OUT" "vitest-duration-summary: 1건" "이름별 분류 — vitest-duration-summary 1건"
if [ -s "$DELETE_LOG" ]; then
  echo "  FAIL dry-run인데 DELETE 로그가 비어있지 않다(실 삭제가 나갔다는 뜻)"
  FAIL=1
else
  echo "  ok   dry-run은 DELETE 요청을 단 하나도 보내지 않는다"
fi

echo
echo "── --apply(실 삭제) ──"
: > "$DELETE_LOG"
APPLY_OUT="$(run_script --apply 2>&1)"
DELETED_IDS="$(sort "$DELETE_LOG" | tr '\n' ' ')"
assert_contains "$DELETED_IDS" "101" "101이 삭제 요청됨"
assert_contains "$DELETED_IDS" "102" "102가 삭제 요청됨"
assert_contains "$DELETED_IDS" "106" "106(lighthouse-results)이 삭제 요청됨"
assert_not_contains "$DELETED_IDS" "103" "103(recent)은 삭제 요청 안 됨"
assert_not_contains "$DELETED_IDS" "104" "104(다른 이름)는 삭제 요청 안 됨"
assert_not_contains "$DELETED_IDS" "105" "105(이미 만료)는 삭제 요청 안 됨"
assert_contains "$DELETED_IDS" "107" "107(shard-durations-2)이 삭제 요청됨(story #3890 확장)"
assert_contains "$DELETED_IDS" "108" "108(vitest-duration-summary)이 삭제 요청됨(story #3890 확장)"
DELETE_COUNT="$(wc -l < "$DELETE_LOG" | tr -d ' ')"
if [ "$DELETE_COUNT" -eq 5 ]; then
  echo "  ok   정확히 5건만 삭제 요청됨(과잉살상 0)"
else
  echo "  FAIL 삭제 요청 건수=${DELETE_COUNT}(기대 5)"
  FAIL=1
fi
echo
echo "── --json 출력 ──"
: > "$DELETE_LOG"
JSON_OUT="$(run_script --apply --json 2>/dev/null)"
JSON_DELETED_COUNT="$(echo "$JSON_OUT" | jq -r '.deleted_count')"
if [ "$JSON_DELETED_COUNT" = "5" ]; then
  echo "  ok   --json 요약의 deleted_count=5"
else
  echo "  FAIL --json deleted_count=${JSON_DELETED_COUNT}(기대 5) — 출력: $JSON_OUT"
  FAIL=1
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASS"
  exit 0
else
  echo "FAILURES ABOVE"
  exit 1
fi
