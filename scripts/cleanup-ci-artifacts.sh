#!/usr/bin/env bash
# story #3864(customer-zero·CI 인프라, 2026-09-14) — GitHub Actions artifact 저장 한도
# 초과(org 단위, 사고 실측: 「Artifact storage quota has been hit」로 mobile 레포의 진단
# artifact 업로드가 막힘 — sprintable 레포 한 곳의 습관이 다른 레포의 진단을 죽이는 클래스).
#
# 원인은 워크플로 쪽에서 이미 닫았다(ci.yml — playwright-report 업로드를 `if: always()`
# 에서 `if: failure()`로·retention 7일→3일 / lighthouse-ci.yml — AC0 실측 결과 bytes
# 기준 전체의 78%를 차지한 lighthouse-results가 소비처 0으로 확認돼 uploadArtifacts를
# false로). 이 스크립트는 «이미 쌓인» 만료 前 playwright-report·lighthouse-results
# artifact 중 오래된 것만 일회성으로 정리한다(AC2 — 반복 실행되는 cron이 아니다,
# "지금 이 부채"를 갚는 용도).
#
# story #3890(2026-09-16) — 위 일회성 정리 뒤에도 CI가 매일 새로 굽는 리포트 artifact가
# 다시 쌓인다(재실측: shard-durations-N 8종 4,846개·4.6MB·vitest-duration-summary
# 100개·49.5MB — ci.yml 쪽 retention은 이 스토리에서 7일→1일로 이미 줄였으나, 이 스크립트를
# 주간 cron(.github/workflows/ci-artifact-cleanup.yml)에 얹어 "그래도 남는" 것까지 정리하는
# 상시 백스톱으로 승격한다). 그래서 기본 이름 목록에 shard-durations-0..7·
# vitest-duration-summary를 추가 — dockerbuild-* 등 report가 아닌 것(빌드 캐시)은 여전히
# 목록 밖(그 클래스는 이 카드 스코프 밖, PO 明示).
#
# ⛔이 스크립트가 «절대 하지 않는» 것(안전 경계, reclaim-merged-worktrees.sh와 동형 원칙):
#   - name이 CLEANUP_ARTIFACT_NAMES 목록에 정확히 없는 artifact는 절대 건드리지 않는다
#     (dmg·apk·dockerbuild-* 등 — PO 규율 명시 "손 0"). 필터는 정확 일치(startswith
#     아님) — "playwright-report-foo" 같은 미래의 다른 이름이 실수로 걸리지 않게.
#   - 이미 만료(expired=true)된 artifact는 건드리지 않는다(GitHub가 곧 자동 정리 — 중복
#     작업 불요, API 응답에 이미 안 잡히거나 상태만 다를 수 있어 명시로 한 번 더 거른다).
#   - CUTOFF_DAYS(기본 7일) 이내에 만들어진 artifact는 절대 안 지운다(최근 실패 run의
#     디버깅 창을 이 스크립트가 먼저 뺏지 않는다 — "일회성 부채 정리"이지 "즉시 0으로"가
#     아니다).
#   - 기본은 dry-run(무엇을 지울지만 보고) — --apply 없이는 실 DELETE 요청을 단 하나도
#     보내지 않는다.
#
# 사용법:
#   scripts/cleanup-ci-artifacts.sh                    # dry-run(기본) — 무엇을 지울지만 보고
#   scripts/cleanup-ci-artifacts.sh --apply             # 실제 삭제
#   scripts/cleanup-ci-artifacts.sh --apply --json      # 기계가 읽을 전후 요약(JSON 한 줄)도 출력
#
# 환경변수:
#   CLEANUP_REPO           기본 moonklabs/sprintable — 대상 레포(owner/repo).
#   CLEANUP_ARTIFACT_NAMES  기본 "playwright-report lighthouse-results shard-durations-0
#                           shard-durations-1 shard-durations-2 shard-durations-3
#                           shard-durations-4 shard-durations-5 shard-durations-6
#                           shard-durations-7 vitest-duration-summary"(story #3890 확장)
#                           — 공백구분 정확 일치 필터 목록(대소문자 구분). 이 목록에 없는
#                           name은 절대 대상 0.
#   CLEANUP_CUTOFF_DAYS    기본 7 — 이 값(일)보다 오래된 것만 삭제 대상.

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

REPO="${CLEANUP_REPO:-moonklabs/sprintable}"
ARTIFACT_NAMES="${CLEANUP_ARTIFACT_NAMES:-playwright-report lighthouse-results shard-durations-0 shard-durations-1 shard-durations-2 shard-durations-3 shard-durations-4 shard-durations-5 shard-durations-6 shard-durations-7 vitest-duration-summary}"
CUTOFF_DAYS="${CLEANUP_CUTOFF_DAYS:-7}"

# 공백구분 이름 목록 → jq IN() 연산용 JSON 배열.
names_json=$(printf '%s\n' $ARTIFACT_NAMES | jq -R . | jq -s .)

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI가 필요합니다" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq가 필요합니다" >&2
  exit 1
fi

# macOS(BSD date)·Linux(GNU date) 양쪽에서 "N일 전" epoch seconds를 구한다.
if date -v-1d >/dev/null 2>&1; then
  cutoff_epoch=$(date -v-"${CUTOFF_DAYS}"d +%s)
else
  cutoff_epoch=$(date -d "-${CUTOFF_DAYS} days" +%s)
fi

echo "대상 레포: ${REPO} · artifact name(정확 일치 목록): ${ARTIFACT_NAMES} · cutoff: ${CUTOFF_DAYS}일 초과" >&2

# 전체 artifact 목록(페이지네이션) — name IN(목록) + expired=false + created_at < cutoff만
# 남긴다. jq -s로 페이지들을 합쳐 «한 번에» 집계(reclaim-merged-worktrees.sh와 동일 원칙 —
# 페이지별 부분합을 셸에서 다시 더하지 않는다, 부분합 누락/중복 클래스 원천 차단).
targets_json=$(gh api --paginate "/repos/${REPO}/actions/artifacts" \
  -q '.artifacts[]' 2>/dev/null | jq -s \
  --argjson names "$names_json" \
  --argjson cutoff "$cutoff_epoch" \
  '[.[] | select((.name as $n | $names | index($n)) != null and .expired == false and (.created_at | fromdateiso8601) < $cutoff)]')

target_count=$(echo "$targets_json" | jq 'length')
target_bytes=$(echo "$targets_json" | jq '[.[].size_in_bytes] | add // 0')

# 이름별 count/bytes(AC2 「전후 count/bytes 이름별」 요구) — 삭제 대상만.
targets_by_name=$(echo "$targets_json" | jq -r 'group_by(.name) | map({name: .[0].name, count: length, bytes: ([.[].size_in_bytes] | add)}) | .[] | "  \(.name): \(.count)건 · \(.bytes) bytes"')

# 전체 만료 前 artifact(필터 무관) 전후 비교용 — AC2 "전후 count/bytes 목록째" 요구.
all_before_json=$(gh api --paginate "/repos/${REPO}/actions/artifacts" \
  -q '.artifacts[]' 2>/dev/null | jq -s '[.[] | select(.expired == false)]')
all_before_count=$(echo "$all_before_json" | jq 'length')
all_before_bytes=$(echo "$all_before_json" | jq '[.[].size_in_bytes] | add // 0')

echo "" >&2
echo "삭제 대상(이름별): " >&2
echo "$targets_by_name" >&2
echo "삭제 대상 합계: ${target_count}건 · ${target_bytes} bytes" >&2
echo "삭제 前 전체(만료 前, 이름 무관): ${all_before_count}건 · ${all_before_bytes} bytes" >&2
echo "" >&2

if [ "$target_count" -eq 0 ]; then
  echo "삭제할 대상이 없습니다." >&2
  if [ "$JSON_OUT" = true ]; then
    jq -n --argjson before_count "$all_before_count" --argjson before_bytes "$all_before_bytes" \
      '{applied: false, deleted_count: 0, deleted_bytes: 0, before_count: $before_count, before_bytes: $before_bytes, after_count: $before_count, after_bytes: $before_bytes}'
  fi
  exit 0
fi

echo "$targets_json" | jq -r '.[] | "  - id=\(.id) created_at=\(.created_at) size_in_bytes=\(.size_in_bytes)"' >&2

if [ "$APPLY" = false ]; then
  echo "" >&2
  echo "dry-run — 실제로는 지우지 않았습니다. --apply로 재실행하면 위 ${target_count}건을 삭제합니다." >&2
  if [ "$JSON_OUT" = true ]; then
    jq -n --argjson target_count "$target_count" --argjson target_bytes "$target_bytes" \
      --argjson before_count "$all_before_count" --argjson before_bytes "$all_before_bytes" \
      '{applied: false, would_delete_count: $target_count, would_delete_bytes: $target_bytes, before_count: $before_count, before_bytes: $before_bytes}'
  fi
  exit 0
fi

# 페드루 PO CHANGES②(카디르 재현, PR#4350 리뷰) — 이전 버전 두 가지 결함:
# (a) `jq ... | while read` 형태는 while 루프가 파이프 오른쪽이라 서브셸에서 돈다 —
#     루프 안에서 늘린 `deleted` 변수는 루프가 끝나면 서브셸과 함께 사라져 바깥에서
#     안 보인다(전형적 bash 서브셸 스코프 함정). (b) 그래서 최종 JSON의 deleted_count는
#     실제 `deleted` 변수를 아예 안 쓰고 삭제 *시도 대상 수*(`target_count`)를 그대로
#     찍었다 — DELETE가 전부 실패해도 deleted_count가 부풀려 보고되고, 실패해도 이
#     스크립트는 exit 0으로 끝났다(호출부 워크플로의 "Fail loudly" 스텝이 못 돎).
# 처방: 프로세스 치환(`< <(...)`)으로 while을 현재 셸에서 돌려 카운터가 안 사라지게
# 하고, deleted/failed를 분리 집계 — 실패가 하나라도 있으면 exit 1.
deleted=0
failed=0
while IFS= read -r id; do
  if gh api -X DELETE "/repos/${REPO}/actions/artifacts/${id}" >/dev/null 2>&1; then
    deleted=$((deleted + 1))
  else
    failed=$((failed + 1))
    echo "  ⚠️ 삭제 실패: id=${id}" >&2
  fi
done < <(echo "$targets_json" | jq -r '.[].id')

# 삭제 뒤 전체 재집계(before와 동일 쿼리 — 전후 대조가 같은 기준이어야 한다).
all_after_json=$(gh api --paginate "/repos/${REPO}/actions/artifacts" \
  -q '.artifacts[]' 2>/dev/null | jq -s '[.[] | select(.expired == false)]')
all_after_count=$(echo "$all_after_json" | jq 'length')
all_after_bytes=$(echo "$all_after_json" | jq '[.[].size_in_bytes] | add // 0')

echo "" >&2
echo "삭제 완료(성공 ${deleted}건 · 실패 ${failed}건). 삭제 後 전체(만료 前, 이름 무관): ${all_after_count}건 · ${all_after_bytes} bytes" >&2
echo "감소: $((all_before_count - all_after_count))건 · $((all_before_bytes - all_after_bytes)) bytes" >&2

if [ "$JSON_OUT" = true ]; then
  jq -n \
    --argjson deleted_count "$deleted" \
    --argjson failed_count "$failed" \
    --argjson before_count "$all_before_count" --argjson before_bytes "$all_before_bytes" \
    --argjson after_count "$all_after_count" --argjson after_bytes "$all_after_bytes" \
    '{applied: true, deleted_count: $deleted_count, failed_count: $failed_count, before_count: $before_count, before_bytes: $before_bytes, after_count: $after_count, after_bytes: $after_bytes}'
fi

if [ "$failed" -gt 0 ]; then
  echo "삭제 ${failed}건 실패 — 위 ⚠️ 로그 참고(gh API/권한 문제 가능성)" >&2
  exit 1
fi
