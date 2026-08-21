"""story #2881(결제 트랙 갭②, 선생님 확定 2026-08-21) — 하향 예약(pending_tier_change).

하향은 즉시 전이가 아니다 — 예약만 받고 다음 갱신일(current_period_end)부터 적용한다
(v2.2 D10, 부분 환불 없음). org당 예약은 최대 1건(재예약은 덮어씀 — 두 번째 예약이
첫 번째를 대체한다는 뜻, 큐가 아니라 단일 슬롯). pending_change_apply_at이 NULL이면
예약 없음(가장 흔한 상태) — sweep(`sweep_pending_tier_downgrades`, toss-billing-
maintenance cron)이 이 값 <= now()인 행만 훑는다.

Revision ID: 0268
Revises: 0267
Create Date: 2026-08-21
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0268"
down_revision = "0267"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("org_subscriptions", sa.Column("pending_tier", sa.Text(), nullable=True))
    op.add_column(
        "org_subscriptions",
        sa.Column("pending_offering_version_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "org_subscriptions", sa.Column("pending_change_apply_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_org_subscriptions_pending_offering_version",
        "org_subscriptions", "offering_versions", ["pending_offering_version_id"], ["id"],
    )


def downgrade() -> None:
    op.drop_constraint("fk_org_subscriptions_pending_offering_version", "org_subscriptions", type_="foreignkey")
    op.drop_column("org_subscriptions", "pending_change_apply_at")
    op.drop_column("org_subscriptions", "pending_offering_version_id")
    op.drop_column("org_subscriptions", "pending_tier")
