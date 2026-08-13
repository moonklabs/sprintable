"""story #2648(P0, 2026-08-14 실사고 발견 — 디디 자신의 키가 실증 사례): 0247이 레거시
`['read','write']` scope 키에 "events"를 잘못 append해 오히려 그 키를 events-그룹-전용으로
좁혀버린 역회귀를 fix-forward로 원상복구한다.

Revision ID: 0248
Revises: 0247
Create Date: 2026-08-14

## 근본 원인(app/dependencies/auth.py + app/services/mcp_toolset.py 실측)
`is_tool_allowed()`가 실제로 "이 scope는 무제한인가"를 판정하는 기준은 `explicit_groups =
tokens & set(ALL_GROUPS)`가 **빈 집합인가**다 — 비어있으면 group_ok=True(그룹 무관 전부
허용, 레거시/미스코프 키의 원래 동작). 0247은 이 진짜 기준 대신 `scope IS NOT NULL AND
array_length(scope, 1) > 0`(배열 길이 휴리스틱)을 썼다 — NULL/빈 배열은 정확히 걸렀지만,
**"비어있지 않지만 ALL_GROUPS와 교집합이 0인 배열"**(레거시 `['read','write']`처럼 그룹
어휘 밖의 토큰만 든 경우)을 "이미 명시적으로 좁혀진 키"로 오분류했다.

그 결과: `['read','write']`(길이 2, ALL_GROUPS 교집합 0=무제한) → 0247이 'events' append →
`['read','write','events']`(길이 3, ALL_GROUPS 교집합={'events'}, **비어있지 않음**) →
`explicit_groups={'events'}` → **오직 events 그룹 도구만 허용, 나머지(chat 포함) 전부
403** — 이게 바로 0247의 docstring이 스스로 경계했던 "무제한 → 특정그룹 전용" 역회귀
그 자체다. 다만 그 경계 가드(`array_length > 0`)가 잡아낸 건 NULL/빈 배열뿐이었고, 이
"교집합 0인 비어있지 않은 배열" 축은 놓쳤다(디디 자신의 dev 키가 이 경로로 실제 사고났다 —
`pgstat-probe-dev` 실측으로 원인 확定).

## 처방
0247을 되돌리지 않는다(히스토리 보존 — fix-forward). 판정 기준을 배열 길이 휴리스틱에서
**`is_tool_allowed()`와 정확히 동형인 진짜 기준**(ALL_GROUPS ∪ {admin}과의 실제 교집합
존재)으로 교체해, 0247이 잘못 건드린 행에서만 'events'를 걷어 원상복구한다.

`_RESTRICTIVE_VOCAB`은 `app/services/mcp_toolset.ALL_GROUPS`(story #2634 이후: rewards·
analytics·agent_runs·audit·webhooks·notifications·meetings·retro·standup·docs·chat·
sprints·hypotheses·epics·tasks·stories·canvas·events·core) ∪ {"admin"}에서 **"events" 자체를
뺀** 집합이다 — "events"를 포함시키면 0247이 건드린 모든 행이 그 'events' 토큰 하나만으로
"교집합 있음"을 자동 통과해 이 마이그 자체가 무의미해진다(자기 자신을 검사 기준에 넣는
순환 오류 — 이 마이그를 작성하며 처음에 실수할 뻔한 지점이라 명시 기록).

## 대상
`revoked_at IS NULL`(폐기 키는 재인증에 안 쓰여 무관) AND `'events' = ANY(scope)`(0247이
건드렸을 가능성이 있는 행만) AND `scope`가 `_RESTRICTIVE_VOCAB`과 교집합이 없음(=events를
빼면 순수 레거시/미지 토큰만 남는 행). 진짜 role-derived 키(예: `['stories','tasks',
'events']`)는 'stories'/'tasks'가 교집합에 걸려 대상에서 제외 — 그대로 유지된다(0247의
원래 의도, 회귀 없음).

downgrade는 no-op이다(0247의 downgrade가 이미 이 케이스를 포함해 전부 되돌리는 더 넓은
연산이라 — `agent_api_keys.scope`에서 `array_remove(scope, 'events')`를 revoked_at IS
NULL·scope IS NOT NULL 전체에 적용, 이 마이그가 다시 뺄 것이 없다).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0248"
down_revision = "0247"
branch_labels = None
depends_on = None

# app/services/mcp_toolset.ALL_GROUPS ∪ {"admin"} − {"events"} — "events"를 넣으면 이 마이그
# 자체가 무의미해진다(위 docstring 참조). 이 리스트가 실제 ALL_GROUPS와 갈리면(그룹 신설/
# 폐지) 이 마이그는 그 시점의 스냅샷 기준으로만 옳다 — 데이터 백필이라 과거 시점 기준이
# 맞다(향후 신설 그룹은 새 마이그가 새 스냅샷으로 처리).
_RESTRICTIVE_VOCAB = (
    "rewards", "analytics", "agent_runs", "audit", "webhooks", "notifications",
    "meetings", "retro", "standup", "docs", "chat", "sprints", "hypotheses",
    "epics", "tasks", "stories", "canvas", "core", "admin",
)


def upgrade() -> None:
    bind = op.get_bind()
    vocab_array = "ARRAY[" + ",".join(f"'{g}'" for g in _RESTRICTIVE_VOCAB) + "]::text[]"
    bind.execute(sa.text(
        "UPDATE agent_api_keys "
        "SET scope = array_remove(scope, 'events') "
        "WHERE revoked_at IS NULL "
        "AND 'events' = ANY(scope) "
        f"AND NOT (scope && {vocab_array})"
    ))


def downgrade() -> None:
    """no-op — 0247.downgrade()가 이미 이 케이스를 포함해 더 넓게 되돌린다(위 docstring 참조)."""
    pass
