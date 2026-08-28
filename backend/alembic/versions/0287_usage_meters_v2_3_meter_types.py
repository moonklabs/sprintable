"""story #2473(결제②-A3): usage_meters.meter_type CHECK를 v2.3 한도표 축으로 확장.

기존 5종(ai_calls/storage_mb/members/agents/stt_minutes)은 그대로 두고 v2.3 한도표
(doc pricing-policy-v2-3 Part 3)의 신규 계측 축 5종을 더한다 — automation_units(AU)·
realtime_connections·webhooks·automation_rules·event_replay_days. 순수 확장(추가)이라
기존 값 파괴·데이터 변형 0 — CHECK 재정의만이라 기존 row는 옛 값 그대로 신규 CHECK를
통과한다(옛 값이 새 집합의 부분집합).

⛔한도 「집행」(ee/plan_limits 등)은 이 스토리 범위 밖 — usage_meters는 값을 담을
그릇만 넓힌다.

Revision ID: 0287
Revises: 0286
Create Date: 2026-08-28
"""
from __future__ import annotations

from alembic import op

revision = "0287"
down_revision = "0286"
branch_labels = None
depends_on = None

_NEW_TYPES = (
    "ai_calls",
    "storage_mb",
    "members",
    "agents",
    "stt_minutes",
    "automation_units",
    "realtime_connections",
    "webhooks",
    "automation_rules",
    "event_replay_days",
)
_OLD_TYPES = ("ai_calls", "storage_mb", "members", "agents", "stt_minutes")


def _check_sql(values: tuple[str, ...]) -> str:
    quoted = ", ".join(f"'{v}'" for v in values)
    return f"meter_type IN ({quoted})"


def upgrade() -> None:
    op.drop_constraint("usage_meters_meter_type_check", "usage_meters", type_="check")
    op.create_check_constraint(
        "usage_meters_meter_type_check",
        "usage_meters",
        _check_sql(_NEW_TYPES),
    )


def downgrade() -> None:
    op.drop_constraint("usage_meters_meter_type_check", "usage_meters", type_="check")
    op.create_check_constraint(
        "usage_meters_meter_type_check",
        "usage_meters",
        _check_sql(_OLD_TYPES),
    )
