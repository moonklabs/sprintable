#!/usr/bin/env bash
# story #4152(CI·결정성, 페드루 PO CHANGES-1) — ci.yml의 detect-changed-scope가
# `backend_test_files_changed` 출력을 정하는 판정을 독립 스크립트로 뽑아
# (check_backend_relevant_diff.sh와 같은 이유로) 임시 git repo만으로 단위 테스트할
# 수 있게 한다.
#
# 판정:
#   - BASE_SHA 미지정(push 이벤트 등, diff 정보 없음) → `__ALL__`(안전측 폴백).
#   - `git diff` 자체가 실패 → `__ALL__`(fail-closed).
#   - 변경 파일 중 `backend/` 밑인데 `backend/tests/[a-zA-Z0-9_]+\.py` 패턴 밖이
#     하나라도 있으면(= backend/app·alembic·pyproject 등 코드/의존성 변경) → `__ALL__`.
#     이 축을 안 두면 코드 변경이 기존 테스트를 진짜로 2.5배 느리게 만드는 회귀도,
#     그 테스트 파일 자신은 diff에 없다는 이유로 WARN(shard_destructive_tests.py
#     ::slow_files_absolute의 diff-scoping)으로 숨어 가드 목적 자체가 깨진다.
#   - 그 외(backend/ 변경이 테스트 파일뿐이거나 0건 — FE-only PR 포함) →
#     backend/tests/*.py 변경분만 공백 구분 한 줄로(0건이면 빈 문자열).
#
# 사용법: classify_backend_test_diff_scope.sh <base_sha> [<head_sha>=HEAD]
# 출력(stdout 1줄): `__ALL__` 또는 `tests/test_a.py tests/test_b.py`(0건이면 빈 줄).
#
# ⚠️ check_backend_relevant_diff.sh와 동형 — «현재 체크아웃된 작업트리» 기준(HEAD_SHA가
# 아닌 실행 시점 CWD의 git 이력 — ci.yml이 이미 head_sha로 체크아웃된 상태에서 호출).
set -uo pipefail

BASE_SHA="${1:-}"
HEAD_SHA="${2:-HEAD}"

if [ -z "${BASE_SHA}" ]; then
    echo "__ALL__"
    exit 0
fi

CHANGED="$(git diff --name-only "${BASE_SHA}...${HEAD_SHA}" 2>&1)"
DIFF_RC=$?
if [ "${DIFF_RC}" -ne 0 ]; then
    echo "__ALL__"
    exit 0
fi

BACKEND_NON_TEST_CHANGED="$(printf '%s\n' "${CHANGED}" \
    | grep -E '^backend/' | grep -vE '^backend/tests/[a-zA-Z0-9_]+\.py$' || true)"

if [ -n "${BACKEND_NON_TEST_CHANGED}" ]; then
    echo "__ALL__"
    exit 0
fi

BACKEND_TEST_FILES_CHANGED="$(printf '%s\n' "${CHANGED}" \
    | grep -E '^backend/tests/[a-zA-Z0-9_]+\.py$' | sed 's#^backend/##' | tr '\n' ' ' | sed 's/ *$//')"
echo "${BACKEND_TEST_FILES_CHANGED}"
