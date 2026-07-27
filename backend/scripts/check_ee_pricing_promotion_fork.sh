#!/usr/bin/env bash
# story #2146: develop→main 승격 준비를 "시작하는 시점"에 ee_pricing 마이그 포크 상태를
# 즉시 보여준다 — 지금까지는 CI 실패(Main Alembic preflight)나 `git rm` 실패로 사후에만
# 드러났다(AC2).
#
# 근본 배경(2026-07-23 실측, PR #2426/#2441 두 승격 비교로 확認):
#   main 은 ee_pricing 전용 마이그 3개(0146/0147/0162)를 갖지 않고, 공유 이름 파일 0163 도
#   main 쪽이 down_revision 을 0161 로 재부모한 다른 내용이다(story bda4beac). develop 은
#   이 4개 파일을 계속 그대로 들고 있다.
#
#   git 의 3-way merge 는 "merge-base 이후 한쪽만 건드리고 반대쪽은 무변경"인 파일을 충돌
#   없이 자동 해소한다 — main 쪽만 삭제/재부모했고 develop 쪽이 그 이후 이 4개 파일을 전혀
#   안 건드렸다면, 다음 승격도 별도 개입 없이 clean 하게 같은 결과로 떨어진다. 이건 "운"이
#   아니라 git 의 결정적 동작이다 — 단, **develop 이 이 4개 파일 중 하나라도 다시 건드리면
#   그 즉시 깨진다.** 이 스크립트는 그 조건이 지금 성립하는지를 승격 착수 시점에 확認한다.
#
# ⛔ 이 스크립트가 못 잡는 것(AC5):
#   1. develop 이 이 4개 파일 "자체"는 안 건드리고 0162 뒤에 새 ee_pricing head 커밋(신규
#      리비전 파일)을 추가하는 경우 — 그 신규 파일은 개별적으로 "main 엔 없음"이 반복될
#      뿐 이 스크립트로는 안 잡힌다. `git diff --stat <merge-base> <develop> --
#      backend/alembic/versions/` 전체를 별도로 볼 것.
#   2. ee_pricing 을 prod(main)로 승격할지 자체는 이 스크립트가 판단하지 않는다 — 그건
#      정책 결정이고 SSOT 문서에 못박아야 할 사안이다(story #2146 AC1, 아직 미결).
#
# Usage: backend/scripts/check_ee_pricing_promotion_fork.sh [main_ref] [develop_ref]
#   기본값: origin/main / origin/develop
set -euo pipefail

MAIN_REF="${1:-origin/main}"
DEVELOP_REF="${2:-origin/develop}"

EE_ONLY_FILES=(
  "backend/alembic/versions/0146_pricing_versions.py"
  "backend/alembic/versions/0147_pricing_versions_live_seed.py"
  "backend/alembic/versions/0162_merge_ee_pricing_core_heads.py"
)
SHARED_FORK_FILE="backend/alembic/versions/0163_strip_stale_runtime_note_from_role_behaviors.py"

MB="$(git merge-base "${MAIN_REF}" "${DEVELOP_REF}")"

echo "=== E-ARCH ee_pricing 승격 포크 체크 (story #2146) ==="
echo "main:        ${MAIN_REF}"
echo "develop:     ${DEVELOP_REF}"
echo "merge-base:  ${MB} ($(git log -1 --format='%h %s' "${MB}"))"
echo

SAFE=1

echo "-- ee 전용 마이그 파일 (0146/0147/0162 — main엔 존재 자체가 없어야 정상) --"
for f in "${EE_ONLY_FILES[@]}"; do
  dev_diff="$(git diff --stat "${MB}" "${DEVELOP_REF}" -- "${f}")"
  if [ -z "${dev_diff}" ]; then
    echo "  OK   ${f} — develop 무변경(merge-base 이후) → clean 유지 예상"
  else
    echo "  ⚠️  ${f} — develop 이 merge-base 이후 이 파일을 건드렸다. clean-merge 보장 깨짐 — 수동 확認 필요"
    SAFE=0
  fi
done

echo
echo "-- 공유 이름 포크 파일 (0163 — 양쪽 다 존재하되 내용이 다르다) --"
dev_diff="$(git diff --stat "${MB}" "${DEVELOP_REF}" -- "${SHARED_FORK_FILE}")"
if [ -z "${dev_diff}" ]; then
  echo "  OK   ${SHARED_FORK_FILE} — develop 무변경 → main 버전(down_revision=0161) 그대로 clean 유지 예상"
else
  echo "  ⚠️  ${SHARED_FORK_FILE} — develop 이 이 파일을 건드렸다. main과 진짜 충돌 가능 — 수동 확認 필요"
  SAFE=0
fi

echo
if [ "${SAFE}" -eq 1 ]; then
  echo "⇒ 이번 승격은 이 4개 파일 축에서는 안전(clean merge 예상)."
else
  echo "⇒ ⛔ 이번 승격은 수동 개입이 필요할 수 있다 — 위 ⚠️ 표시된 파일을 승격 전에 직접 검토할 것."
fi
echo "⛔ ee_pricing 자체를 prod로 승격할지는 여전히 미결(story #2146 AC1) — 이 스크립트는 그 판단을 내리지 않는다."
