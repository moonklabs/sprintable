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
# 사용법: classify_backend_test_diff_scope.sh <base_sha> [<head_sha>=HEAD] [two-dot]
#   세 번째 인자 `two-dot`(story #4206 · 까디르 P2): push 범위 판정용. PR은 base…head(세 점 — merge-base 기준,
#   base 쪽에만 있는 변경은 PR 것이 아니다)가 맞지만, push는 «before에서 after로 무엇이 바뀌었나» 자체가 질문이라
#   두 점(before after)이어야 한다 — 되감는 force push(after가 before의 조상)에서 세 점은 merge-base=after라 빈
#   집합이 나와 백엔드 코드가 바뀌었는데도 «변경 없음»으로 판정됐다.
# 출력(stdout 3줄, story #4163 확장):
#   줄1(기존 계약 그대로) — `__ALL__` 또는 `tests/test_a.py tests/test_b.py`(0건이면 빈 줄).
#   줄2(신규) — 줄1이 `__ALL__`(코드/의존성 변경 사유)일 때만: 변경된
#     `backend/app/**.py` 모듈 경로를 공백 구분으로(`app/services/foo.py` 형,
#     `backend/` 접두사 제거). 그 외 경우(줄1이 __ALL__이 아니거나, push-이벤트
#     fail-closed 등 diff 정보 자체가 없는 __ALL__)는 빈 줄 — 좁히기(story #4163
#     RED-범위 축소)는 "app 코드 변경 탓에 __ALL__이 된" 경우에만 의미가 있다
#     (diff 정보 자체가 없으면 무엇을 import하는지도 판단 불가 — 안전측 그대로 전부).
#   줄3(신규) — 줄1이 `__ALL__`일 때 **함께** 변경된 `backend/tests/*.py`(있으면).
#     "app 코드 + 그 PR이 직접 건드린 테스트 파일" 혼합 변경(예: app/x.py와
#     tests/test_new.py를 같은 PR에서 함께 바꿈)에서, narrowing이 app-모듈-의존
#     테스트만 좁히고 "이 PR이 직접 수정한 테스트 자신"을 빠뜨리면 그 테스트는
#     RED로 남아야 하는데 WARN으로 새 버린다 — ci.yml이 줄2(모듈-의존 목록)와 줄3
#     (직접 변경 목록)을 합집합해 narrowed 목록을 만든다.
#
# ⚠️ check_backend_relevant_diff.sh와 동형 — «현재 체크아웃된 작업트리» 기준(HEAD_SHA가
# 아닌 실행 시점 CWD의 git 이력 — ci.yml이 이미 head_sha로 체크아웃된 상태에서 호출).
set -uo pipefail

BASE_SHA="${1:-}"
HEAD_SHA="${2:-HEAD}"
DIFF_MODE="${3:-three-dot}"

if [ -z "${BASE_SHA}" ]; then
    echo "__ALL__"
    echo ""
    echo ""
    exit 0
fi

if [ "${DIFF_MODE}" = "two-dot" ]; then
    CHANGED="$(git diff --name-only "${BASE_SHA}" "${HEAD_SHA}" 2>&1)"
else
    CHANGED="$(git diff --name-only "${BASE_SHA}...${HEAD_SHA}" 2>&1)"
fi
DIFF_RC=$?
if [ "${DIFF_RC}" -ne 0 ]; then
    echo "__ALL__"
    echo ""
    echo ""
    exit 0
fi

BACKEND_NON_TEST_CHANGED="$(printf '%s\n' "${CHANGED}" \
    | grep -E '^backend/' | grep -vE '^backend/tests/[a-zA-Z0-9_]+\.py$' || true)"

if [ -n "${BACKEND_NON_TEST_CHANGED}" ]; then
    echo "__ALL__"
    # story #4163 — app 모듈만(alembic·pyproject 등은 import-그래프 narrowing과 무관 —
    # 테스트가 마이그레이션 파일을 "import"하는 경우는 없다).
    CHANGED_APP_MODULES="$(printf '%s\n' "${BACKEND_NON_TEST_CHANGED}" \
        | grep -E '^backend/app/.*\.py$' | sed 's#^backend/##' | tr '\n' ' ' | sed 's/ *$//' || true)"
    echo "${CHANGED_APP_MODULES}"
    # story #4163 — 혼합 변경(app + 이 PR이 직접 건드린 테스트)에서 그 테스트 자신도
    # narrowed 목록에 들어가야 RED 유지(AC1).
    CHANGED_TEST_FILES_MIXED="$(printf '%s\n' "${CHANGED}" \
        | grep -E '^backend/tests/[a-zA-Z0-9_]+\.py$' | sed 's#^backend/##' | tr '\n' ' ' | sed 's/ *$//' || true)"
    echo "${CHANGED_TEST_FILES_MIXED}"
    exit 0
fi

BACKEND_TEST_FILES_CHANGED="$(printf '%s\n' "${CHANGED}" \
    | grep -E '^backend/tests/[a-zA-Z0-9_]+\.py$' | sed 's#^backend/##' | tr '\n' ' ' | sed 's/ *$//')"
echo "${BACKEND_TEST_FILES_CHANGED}"
echo ""
echo ""
