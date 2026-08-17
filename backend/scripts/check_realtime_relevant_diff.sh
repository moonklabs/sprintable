#!/usr/bin/env bash
# story #2089 (a) — realtime path-filter.
#
# #2182 그라운딩(미르코, 2026-08-17)에서 실측: 최근 2주 backend 변경 커밋 162개 중
# realtime이 실제로 참조하는 파일을 건드린 건 40개(24.7%)뿐이었다 — 즉 오늘까지의 502
# rolling의 75.3%는 "realtime 코드가 실제로 안 바뀐 커밋"이 deploy-realtime-gce를 무조건
# 재실행시켜 생긴 것이었다. 이 스크립트는 두 커밋 사이에 그 경로가 바뀌었는지만 판별한다
# — 판별해서 실제 배포/스킵을 결정하는 건 호출부(cloudbuild.yaml)의 몫이다.
#
# 경로 목록은 **보수적으로**(페드루 PO 판정, 2026-08-17) 채택했다 — realtime 전용 코드
# (events.py·agent_gateway.py 등)만으론 11.1%까지 좁힐 수 있었지만, auth.py·database.py
# 같은 "backend 전역도 같이 쓰지만 realtime도 실제로 부르는" 공유 파일까지 넣은 24.7% 셋을
# 썼다 — 좁히면 "공유 파일이 바뀌었는데 realtime 동작도 같이 바뀌었을 수 있는데 배포를
# 안 하는" stale binary 미탐 위험이 있기 때문("빈도"보다 "정확성"을 우선한다는 판정).
#
# exit 0 = 배포해야 함(관련 경로 변경 있음 — 또는 판별 자체가 불가능해 안전하게 배포 쪽을
#          택함, "필터가 실수로 좁아도 조용히 안 새게"라는 PO 요구사항의 구현).
# exit 1 = 스킵해도 됨(관련 경로 변경이 확실히 없을 때만).
#
# 사용법:
#   backend/scripts/check_realtime_relevant_diff.sh <from_sha> [<to_sha=HEAD>]
#   FROM_SHA를 생략하면(빈 문자열) 판별 불가로 간주 — exit 0(배포 쪽).
#
# ⚠️git fetch/unshallow는 호출부(cloudbuild.yaml)가 필요하면 이 스크립트 호출 전에 직접
# 한다 — 이 스크립트 자체는 순수 git diff 판별만 하고 네트워크 I/O를 하지 않는다(테스트
# 용이성 — 로컬 임시 git repo만으로 이 스크립트 전체를 검증할 수 있어야 한다).

set -uo pipefail  # ⚠️-e 없음 — git diff 실패를 우리가 직접 잡아 fail-safe 분기로 보낸다

REALTIME_RELEVANT_PATHS=(
    "backend/app/realtime_main.py"
    "backend/app/routers/agent_gateway.py"
    "backend/app/routers/events.py"
    "backend/app/routers/health.py"
    "backend/app/dependencies/auth.py"
    "backend/app/core/database.py"
    "backend/app/core/shutdown.py"
    "backend/app/dependencies/database.py"
    "backend/app/models/agent_gateway.py"
    "backend/app/models/event.py"
    "backend/app/models/organization.py"
    "backend/app/models/team.py"
    "backend/app/services/agent_onboarding_config.py"
    "backend/app/dependencies/ownership.py"
    "backend/app/services/member_resolver.py"
    "backend/app/services/realtime_readiness.py"
    "backend/app/core/config.py"
    "backend/app/core/logging_config.py"
    "backend/app/core/rate_limit.py"
    "backend/app/services/pg_pubsub.py"
    "backend/scripts/deploy_realtime_gce.sh"
    "backend/scripts/provision_realtime_gclb.sh"
)

FROM_SHA="${1:-}"
TO_SHA="${2:-HEAD}"

if [ -z "${FROM_SHA}" ]; then
    echo "check_realtime_relevant_diff: FROM_SHA 미지정 — 판별 불가, 안전하게 배포 쪽(exit 0)" >&2
    exit 0
fi

_DIFF_OUTPUT="$(git diff --name-only "${FROM_SHA}...${TO_SHA}" -- "${REALTIME_RELEVANT_PATHS[@]}" 2>&1)"
_DIFF_RC=$?

if [ "${_DIFF_RC}" -ne 0 ]; then
    echo "check_realtime_relevant_diff: git diff ${FROM_SHA}...${TO_SHA} 실패(rc=${_DIFF_RC}: ${_DIFF_OUTPUT}) — 판별 불가, 안전하게 배포 쪽(exit 0)" >&2
    exit 0
fi

if [ -z "${_DIFF_OUTPUT}" ]; then
    echo "check_realtime_relevant_diff: ${FROM_SHA}..${TO_SHA} 사이 realtime-관련 경로 변경 없음 — 스킵 가능(exit 1)" >&2
    exit 1
fi

echo "check_realtime_relevant_diff: realtime-관련 경로 변경 있음 —" >&2
echo "${_DIFF_OUTPUT}" >&2
exit 0
