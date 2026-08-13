"""0247 판정 오류 fix-forward — 0247의 WHERE 절(`scope IS NOT NULL AND array_length(scope,
1) > 0`)은 "무제한 scope"를 배열 길이 휴리스틱으로 판정했다. 그러나 실제 무제한 판정은
`is_tool_allowed()`(app/services/mcp_toolset.py)의 `explicit_groups = tokens &
set(ALL_GROUPS) | (tokens & {"admin"})`가 **빈 집합인가**다 — 레거시 `['read','write']`
scope 키는 배열 길이가 2(비어있지 않음)라 0247의 WHERE를 통과해 'events'가 append됐지만,
'read'/'write'는 ALL_GROUPS 소속이 아니므로 append 전 explicit_groups는 원래 빈 집합
(무제한)이었다. append 후에는 explicit_groups={'events'}(비어있지 않음)가 돼
`group_ok = group in tokens`로 판정이 바뀌고, 'events' 그룹 밖의 모든 도구(chat/stories/
tasks 등 전부)가 거부되는 **정반대 방향 재발**(무제한 → events전용)이 실제로 발생했다
(디디/은두카쿠 자신의 레거시 read/write 키가 실증 사례 — fleet 전체의 동형 레거시 키도
동일하게 영향받았을 것으로 추정).

Revision ID: 0248
Revises: 0247
Create Date: 2026-08-14

[[no-pr-for-data]] 게이트 — 0246/0247과 동일 승인 경로(P1 플랜 범위 PO 판정, 선생님께
승격 보고에 얹어 통보). 이 마이그는 fix-forward다: 0247 자체는 히스토리 보존을 위해 그대로
두고(리버트하지 않음), 이 파일이 그 결과 중 실수로 좁혀진 부분만 원상복구한다.

⛔**판정 기준을 배열 길이가 아니라 실제 그룹 어휘와의 교집합으로 바꾼다** — `is_tool_allowed`와
정확히 동형이 되도록, "이 키가 이미 명시적으로 좁혀져 있었는가"를
`array_remove(scope, 'events') && (ALL_GROUPS ∪ {'admin'})`(교집합 존재)로 판정한다.
교집합이 있으면(예: `['chat','stories']` → events가 추가돼 `['chat','stories','events']`가
된 키, 또는 `['admin']` 키) 그 키는 0247 이전부터 이미 명시 그룹으로 좁혀져 있었다는 뜻이므로
0247의 "events로 넓힌다"는 의도가 정확히 맞았던 케이스 — 손대지 않는다. 교집합이 없으면(레거시
`['read','write']`만 있던 키, 또는 사람이 실수로 넣은 그룹-아닌 토큰만 있던 키) 0247이 이
키를 무제한→events전용으로 잘못 좁힌 것이므로 'events'만 제거해 원상복구한다.

ALL_GROUPS 리터럴은 `app/services/mcp_toolset.py`의 `ALL_GROUPS`(= `_GROUP_KEYWORDS`에서
"admin" 제외 + "core")를 이 작성 시점 기준으로 그대로 복사했다 — 마이그는 app 모듈을 import하지
않는 관례(0246/0247과 동일)라 이후 그룹이 추가/삭제되면 이 리스트는 수동 동기화가 필요하다
(현재 시점 기준 드리프트 없음 확인 완료).

⚠️**알려진 한계(솔직히 기록)**: 이 판정은 "현재 scope에 events만 있고 다른 그룹이 없다"는
사실만으로 되돌린다 — 0247이 실수로 events를 넣은 경우와, 애초부터 의도적으로
`scope=['events']`(events 그룹 전용) 로 발급된 키가 우연히 동일한 최종 상태를 만들었을
경우를 데이터만으로는 구분할 수 없다(0247이 남긴 별도 audit 백업이 없음). 다만 이 케이스는
role_template.default_tool_groups가 events 단독으로 구성된 role이 현재 카탈로그에
존재하는지에 달려 있고(catalog 관례상 각 role은 통상 복수 도메인 그룹을 가짐), 병합 전
선생님/PO가 라이브 조회로 `scope = ARRAY['events']`인 키가 0247 이전부터 그 상태였는지
확인하는 것을 권장한다(이 마이그 자체는 fleet 규모상 유의미한 그런 키가 없다는 가정 하에
진행 — 있다면 이 마이그 적용 전 별도 예외 처리 필요).

⛔**키 재발급(rotate) 미사용** — 0247과 동일 이유(app/repositories/api_key.py 참조):
scope 컬럼값만 UPDATE, key_hash/plaintext 불변이라 배포된 키는 그대로 살아있고 다음 요청부터
바로잡힌 scope로 인증된다.

범위: revoked_at IS NULL(살아있는 키만) AND 'events' = ANY(scope) — 현재 살아있고 events를
보유한 모든 키를 재평가한다(0247이 실제로 건드린 행으로 한정하지 않음 — 판정 기준이
`is_tool_allowed`와 동형이라 이력과 무관하게 현재 상태만으로 자기교정적이다).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0248"
down_revision = "0247"
branch_labels = None
depends_on = None

# app/services/mcp_toolset.py::ALL_GROUPS ∪ {"admin"} 리터럴 스냅샷(2026-08-14 기준).
# 그룹이 추가/삭제되면 이 리스트도 함께 갱신할 것 — 마이그는 app 모듈을 import하지 않는다.
_REAL_GROUP_TOKENS = (
    "rewards", "analytics", "agent_runs", "audit", "webhooks", "notifications",
    "meetings", "retro", "standup", "docs", "chat", "sprints", "hypotheses",
    "epics", "tasks", "stories", "canvas", "core", "admin",
)


def upgrade() -> None:
    bind = op.get_bind()
    group_array_literal = "ARRAY[" + ",".join(f"'{g}'" for g in _REAL_GROUP_TOKENS) + "]::text[]"
    bind.execute(sa.text(
        "UPDATE agent_api_keys "
        "SET scope = array_remove(scope, 'events') "
        "WHERE revoked_at IS NULL "
        "AND scope IS NOT NULL "
        "AND 'events' = ANY(scope) "
        f"AND NOT (array_remove(scope, 'events') && {group_array_literal})"
    ))


def downgrade() -> None:
    # 0247.upgrade()와 동일 로직 재적용 — upgrade()가 벗겨낸 것과 정확히 같은 집합(events가
    # 없고 array가 비어있지 않은 살아있는 키)에 다시 events를 append해 0248 적용 전 상태로 복원.
    bind = op.get_bind()
    bind.execute(sa.text(
        "UPDATE agent_api_keys "
        "SET scope = array_append(scope, 'events') "
        "WHERE revoked_at IS NULL "
        "AND scope IS NOT NULL AND array_length(scope, 1) > 0 "
        "AND NOT ('events' = ANY(scope))"
    ))
