#!/usr/bin/env bash
# story #3897 — backend/tests/**가 실제로 참조하는 FE(apps/web/·packages/) 경로를 «코드로
# 추출»한다(손으로 적는 allowlist 아님). ci.yml의 detect-changed-scope가 이 목록을 써서
# «apps/web/만 바뀐 PR은 백엔드-무관»이라는 기존 판정을 보정한다 — 3889 사고(PR 4294가
# apps/web/messages/ko.json을 바꿨지만 BE i18n_catalog와의 파리티 테스트
# test_3815_youtube_publish.py가 그 파일을 직접 읽어 대조하는데도, 경로 기반 스킵이 그
# 참조를 몰라 develop CI에서만 RED가 터졌다)의 구조 처방.
#
# 추출 대상 2가지 형태(둘 다 backend/tests/**/*.py 실사용 실측, 2026-09-15 그라운딩):
#   ① 한 문자열 리터럴: "apps/web/messages/ko.json" · "apps/web/src/app"(디렉터리도 포함 —
#      deeplink_contract_lib.py의 APPS_WEB_APP_DIR처럼 디렉터리 루트를 나중에 조합해 쓰는
#      실제 코드가 있다. 확장자 유무로 거르지 않는다 — 디렉터리 의존도 진짜 의존이다.)
#   ② 세그먼트 조인: "apps" / "web" / "messages" / "ko.json"(pathlib `/` 연산자 스타일)
#
# 둘 다 실제 큰따옴표로 감싼 리터럴만 잡는다 — 괄호 안 설명문("...apps/web/foo.ts 참고")
# 이나 인용부호 없는 산문("apps/web 쪽")은 정규식이 여는/닫는 " 를 요구해 자연히 걸러진다
# (완전한 정확성은 아니다 — docstring 안에 «따옴표로 감싼» 경로 언급도 코드상 실제
# read/Path 사용과 구분 없이 같이 잡힌다. 이건 의도적 — 과다포함은 안전한 방향
# (backend_relevant=true가 늘어 CI 시간이 조금 늘 뿐)이고, 과소포함이 위험한 방향
# (실 파리티 테스트가 놓쳐 develop에서만 터짐)이라 grep 기반의 보수적 초과 추출을 택한다).
#
# 사용법: extract_fe_paths_referenced_by_backend_tests.sh [test_root=backend/tests]
# stdout: 추출된 경로 1줄당 1개(정렬·중복 제거).
# exit 0 = 1건 이상 추출(정상). exit 1 = 0건(fail-closed — 정규식이 깨졌거나 테스트 트리가
#          통째로 사라진 신호로 보고, 호출부가 backend_relevant=true로 안전하게 처리해야
#          한다 — 「추출 0건」을 «FE 의존 없음»으로 읽지 않는다).

set -uo pipefail

TEST_ROOT="${1:-backend/tests}"

if [ ! -d "${TEST_ROOT}" ]; then
    echo "extract_fe_paths_referenced_by_backend_tests: ${TEST_ROOT} 없음 — fail-closed exit 1" >&2
    exit 1
fi

FILES="$(find "${TEST_ROOT}" -name '*.py' -type f)"
if [ -z "${FILES}" ]; then
    echo "extract_fe_paths_referenced_by_backend_tests: ${TEST_ROOT} 안에 *.py 0건 — fail-closed exit 1" >&2
    exit 1
fi

# ① 한 문자열 리터럴 형태 — "apps/web/..." 또는 "packages/..."(경로 문자만, 따옴표로 닫힘).
SINGLE="$(printf '%s\n' "${FILES}" | xargs grep -ohE '"(apps/web|packages)/[A-Za-z0-9_./-]+"' -- 2>/dev/null | tr -d '"')"

# ② 세그먼트 조인 형태 — "apps" / "web"(또는 "packages")로 시작해 "/" 로 이어지는 2개 이상
# 문자열 세그먼트. 매치된 전체 조각에서 각 "..." 세그먼트만 뽑아 "/"로 재조립한다.
SEGMENTED_RAW="$(printf '%s\n' "${FILES}" | xargs grep -ohE '"(apps|packages)"([[:space:]]*/[[:space:]]*"[A-Za-z0-9_.-]+")+' -- 2>/dev/null)"
SEGMENTED=""
if [ -n "${SEGMENTED_RAW}" ]; then
    SEGMENTED="$(printf '%s\n' "${SEGMENTED_RAW}" | while IFS= read -r line; do
        [ -z "${line}" ] && continue
        grep -oE '"[A-Za-z0-9_.-]+"' <<< "${line}" | tr -d '"' | paste -sd '/' -
    done)"
fi

ALL="$(printf '%s\n%s\n' "${SINGLE}" "${SEGMENTED}" | grep -v '^$' | sort -u)"

if [ -z "${ALL}" ]; then
    echo "extract_fe_paths_referenced_by_backend_tests: 추출 0건 — fail-closed exit 1" >&2
    exit 1
fi

printf '%s\n' "${ALL}"
exit 0
