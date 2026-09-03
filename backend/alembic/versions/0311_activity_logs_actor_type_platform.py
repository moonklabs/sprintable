"""story #3369(Phase0 S3·마케팅 운영 플랫폼 v3, 페드루 PO 확定 2026-09-03) —
activity_logs.actor_type CHECK를 'platform'까지 넓힌다.

승인은 human이 결정하지만 승인본을 공개 projection(site_posts)에 반영하는 실행 자체는
서버(platform)가 한다 — "누가 결정했나"와 "누가 실행했나"를 같은 actor_type 값으로
뭉치면 감사 로그에서 그 구분이 사라진다(story 4b580094 AC5). 순수 확장(기존 두 값은
그대로 유지)이라 기존 row는 옛 값 그대로 새 CHECK를 통과한다 — 0287
(usage_meters.meter_type)과 같은 관례.

번호 의존성 — S2(story #3367, PR#3733)가 0310을 이미 썼다(gate.sealed_content_*).
그 PR이 develop에 먼저 머지되면 이 리비전은 그대로 0310 위에 선다(순서 무관, 도메인이
완전히 다르다 — activity_logs vs gate).

Revision ID: 0311
Revises: 0310
Create Date: 2026-09-03
"""
from __future__ import annotations

from alembic import op

revision = "0311"
down_revision = "0310"
branch_labels = None
depends_on = None

_NEW_TYPES = ("agent", "human", "platform")
_OLD_TYPES = ("agent", "human")


def _check_sql(values: tuple[str, ...]) -> str:
    quoted = ", ".join(f"'{v}'" for v in values)
    return f"actor_type IN ({quoted})"


def upgrade() -> None:
    op.drop_constraint("ck_activity_logs_actor_type", "activity_logs", type_="check")
    op.create_check_constraint(
        "ck_activity_logs_actor_type", "activity_logs", _check_sql(_NEW_TYPES),
    )


def downgrade() -> None:
    op.drop_constraint("ck_activity_logs_actor_type", "activity_logs", type_="check")
    op.create_check_constraint(
        "ck_activity_logs_actor_type", "activity_logs", _check_sql(_OLD_TYPES),
    )
