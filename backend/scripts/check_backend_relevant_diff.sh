#!/usr/bin/env bash
# story #3897 — ci.yml의 detect-changed-scope 판정 전체 로직을 독립 스크립트로 뽑아
# (check_realtime_relevant_diff.sh와 같은 이유로) 임시 git repo만으로 단위 테스트할 수
# 있게 한다.
#
# 판정 순서:
#   1) 변경 파일이 전부 «백엔드-무관 allowlist»(docs/·*.md·apps/web/·packages/) 안이 아니면
#      → 관련(exit 0, fail-closed).
#   2) allowlist 안이어도, backend/tests/**/*.py가 «코드로» 참조하는(추출된) FE 경로를 하나
#      라도 건드리면 → 관련(exit 0) — 3889 사고(파리티 테스트가 실제로 그 파일을 읽는데
#      경로 기반 스킵이 몰라서 develop CI에서만 RED) 처방.
#   3) 둘 다 아니면 → 무관(exit 1, 스킵 가능).
#   FE 경로 추출 자체가 실패/0건이면(extract_fe_paths_referenced_by_backend_tests.sh가
#   exit 1) → fail-closed로 관련(exit 0).
#
# exit 0 = backend_relevant=true(백엔드 잡 전량 실행).
# exit 1 = backend_relevant=false(백엔드 무거운 잡 skip 가능).
#
# 사용법: check_backend_relevant_diff.sh <base_sha> [<head_sha>=HEAD]
#   BASE_SHA 미지정(빈 문자열) = PR 컨텍스트 아님(push 이벤트 등) — 판별 불가, fail-closed
#   로 관련(exit 0).
#
# ⚠️ 이 스크립트는 «현재 체크아웃된 작업트리»의 backend/tests/를 스캔한다(HEAD_SHA가 아닌
# CWD 기준 — ci.yml이 이미 head_sha로 체크아웃된 상태에서 호출하므로 일치한다. 로컬 테스트도
# 임시 repo를 checkout한 상태에서 cwd를 그 repo로 잡아 호출한다).

set -uo pipefail

BASE_SHA="${1:-}"
HEAD_SHA="${2:-HEAD}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${BASE_SHA}" ]; then
    echo "check_backend_relevant_diff: BASE_SHA 미지정 — PR 컨텍스트 아님, fail-closed 관련(exit 0)" >&2
    exit 0
fi

CHANGED="$(git diff --name-only "${BASE_SHA}...${HEAD_SHA}" 2>&1)"
DIFF_RC=$?
if [ "${DIFF_RC}" -ne 0 ]; then
    echo "check_backend_relevant_diff: git diff ${BASE_SHA}...${HEAD_SHA} 실패(rc=${DIFF_RC}) — fail-closed 관련(exit 0)" >&2
    echo "${CHANGED}" >&2
    exit 0
fi

echo "check_backend_relevant_diff: changed files —" >&2
echo "${CHANGED}" >&2

NON_SAFE="$(printf '%s\n' "${CHANGED}" | grep -Ev '^docs/|\.md$|^apps/web/|^packages/' || true)"

if [ -n "${NON_SAFE}" ] || [ -z "${CHANGED}" ]; then
    echo "check_backend_relevant_diff: allowlist 밖 변경 있음(또는 변경 0건) — 관련(exit 0)" >&2
    exit 0
fi

FE_DEPS="$(bash "${SCRIPT_DIR}/extract_fe_paths_referenced_by_backend_tests.sh" backend/tests)"
FE_DEPS_RC=$?
if [ "${FE_DEPS_RC}" -ne 0 ] || [ -z "${FE_DEPS}" ]; then
    echo "check_backend_relevant_diff: FE 경로 추출 실패/0건(rc=${FE_DEPS_RC}) — fail-closed 관련(exit 0)" >&2
    exit 0
fi

FE_DEP_HIT=""
while IFS= read -r dep; do
    [ -z "${dep}" ] && continue
    while IFS= read -r f; do
        [ -z "${f}" ] && continue
        if [ "${f}" = "${dep}" ] || [[ "${f}" == "${dep}/"* ]]; then
            FE_DEP_HIT="backend/tests가 참조하는 ${dep} (변경 파일: ${f})"
            break 2
        fi
    done <<< "${CHANGED}"
done <<< "${FE_DEPS}"

if [ -n "${FE_DEP_HIT}" ]; then
    echo "check_backend_relevant_diff: ${FE_DEP_HIT} — 관련(exit 0)" >&2
    exit 0
fi

echo "check_backend_relevant_diff: 전 변경 파일이 백엔드-무관 allowlist 안 + backend/tests가 참조하는 FE 경로 무접촉 — 무관(exit 1)" >&2
exit 1
