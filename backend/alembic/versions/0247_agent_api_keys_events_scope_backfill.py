"""story #2635 준비(카디르 QA verdict 발견, 페드루군 지시 2026-08-13) — 0246만으로는
fleet에 「events」가 소급되지 않는다: scope 집행은 매 요청 role_template을 재조회하지
않고 `agent_api_keys.scope`(발급/rotate 시점에 role_template.default_tool_groups를 복사해
넣은 **스냅샷**, `_resolve_api_key` 실측 — `app/dependencies/auth.py`)를 그대로 읽는다.
0246이 role_templates를 갱신해도 이미 발급된 fleet 키의 scope 배열은 그 순간에 얼어붙어
있다 — 이 마이그가 "만들어졌는데 도는 자리가 없다" 재발을 막는 두 번째 절반이다.

Revision ID: 0247
Revises: 0246
Create Date: 2026-08-14

[[no-pr-for-data]] 데이터 마이그레이션 게이트 — 0246과 동일 승인 경로(P1 플랜 범위 PO 판정,
선생님께 승격 보고에 얹어 통보).

⛔**키 재발급(rotate)은 쓰지 않는다** — `ApiKeyRepository.rotate()`는 기존 키를 revoke하고
새 plaintext를 발급한다(app/repositories/api_key.py). fleet 전체에 rotate를 돌리면 이미
각 에이전트 런타임에 배포된 `AGENT_API_KEY` 값이 전부 무효화돼 재배포 없인 즉시 전멸한다
(migration이 유발하는 최악의 blast radius). 이 마이그는 `scope` **컬럼값만** UPDATE한다 —
key_hash/plaintext는 전혀 안 건드리므로 이미 배포된 키 문자열은 그대로 살아있고, 다음 요청부터
넓어진 scope로 인증된다(`_resolve_api_key`가 매 요청 DB에서 scope를 fresh SELECT하므로
캐시 무효화도 불필요 — 이 자체가 "소급이 되는" 근거).

⛔**NULL/빈 배열 scope는 절대 건드리지 않는다** — `is_tool_allowed()`(app/services/
mcp_toolset.py)는 `tokens = set(scope or [])`; `explicit_groups = tokens & ALL_GROUPS`가
**빈 집합이면 `group_ok = True`**(그룹 무관 전부 허용 — 레거시/미스코프 키의 기존 동작).
NULL이든 빈 배열이든 여기 해당해 사실상 "무제한"이다. 여기에 `array_append(scope, 'events')`
를 실수로 적용하면 `{events}` 라는 **비어있지 않은** 배열이 돼 `explicit_groups`가 처음으로
채워지고, events 그룹 밖의 모든 도구가 갑자기 거부되는 정반대 방향 재발(무제한 → events전용)
이 벌어진다 — 그래서 WHERE 절이 `scope IS NOT NULL AND array_length(scope, 1) > 0`을 명시
요구한다(빈 배열의 `array_length(..., 1)`은 Postgres에서 NULL이라 `> 0` 비교가 자동으로
걸러준다).

⚠️(페드루군 리뷰 정밀화, 2026-08-13) 대상을 "role-derived scope"라고 부르면 실제보다
좁게 말하는 것이다 — SQL은 그 배열이 `recruit_agent()`가 role_template에서 파생시킨 것인지,
아니면 다른 경로(예: 수기로 좁혀 발급한 키)로 의도적으로 좁힌 것인지 구분할 수 없다. 실제
대상은 정확히 **"현재 살아있고, scope가 명시적으로 채워진(NULL도 빈 배열도 아닌) 모든 키"**
다 — 이 전체를 "events"를 포함하도록 넓히는 것 자체가 이번 enablement 판정의 범위(PO
판정, #3031 리뷰)이므로 동작은 그대로 두되, 이 docstring은 그 판정의 실제 폭을 정확히
기록한다(감사 기록이 실제보다 좁게 말하면 나중에 "그때 의도적으로 좁힌 키까지 넓혔나?"를
다시 조사해야 한다 — 그 재조사를 없애는 게 이 정정의 목적).

범위: revoked_at IS NULL(살아있는 키만 — 폐기된 키는 다시 인증에 쓰이지 않아 건드릴 이유가
없다). scope 폐기(rotate 등)는 이 마이그 밖에서 자연 발생하는 일이라 무관하게 둔다.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0247"
down_revision = "0246"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        "UPDATE agent_api_keys "
        "SET scope = array_append(scope, 'events') "
        "WHERE revoked_at IS NULL "
        "AND scope IS NOT NULL AND array_length(scope, 1) > 0 "
        "AND NOT ('events' = ANY(scope))"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        "UPDATE agent_api_keys "
        "SET scope = array_remove(scope, 'events') "
        "WHERE revoked_at IS NULL AND scope IS NOT NULL"
    ))
