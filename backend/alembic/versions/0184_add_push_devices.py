"""add push_devices table for E-MOBILE push registration (E-MOBILE M0·S2)

webhook_configs 동형: member-owned·org/project 무관 member-global. EE 라우터가 소비하나 테이블/모델/
마이그는 core 체인에 선형 append(기존 EE 테이블 plan_tier_limits·pricing 동형) — 별도 EE 헤드 분기는
0146(ee_pricing) 에서 dual-head prod 승격 깨져 0162 에서 되돌린 선례라 재도입 금지. branch_labels=None.

Revision ID: 0184
Revises: 0183
Create Date: 2026-07-15
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0184"
down_revision = "0183"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "push_devices",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "org_id",
            UUID(as_uuid=True),
            sa.ForeignKey("organizations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # member_id: webhook_configs(0079) 선례로 FK 미부착(grant-only write 500 해소). 소유 스코프는
        # 쿼리시점 org_id AND member_id 로 강제.
        sa.Column("member_id", UUID(as_uuid=True), nullable=False),
        sa.Column("expo_push_token", sa.Text, nullable=False),
        sa.Column("platform", sa.Text, nullable=False),
        sa.Column("device_id", sa.Text, nullable=True),
        sa.Column("app_version", sa.Text, nullable=True),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("platform IN ('ios', 'android')", name="push_devices_platform_check"),
        sa.UniqueConstraint("expo_push_token", name="uq_push_devices_expo_push_token"),
    )
    op.create_index("idx_push_devices_member", "push_devices", ["member_id"])
    op.create_index("idx_push_devices_org", "push_devices", ["org_id"])


def downgrade() -> None:
    op.drop_index("idx_push_devices_org", table_name="push_devices")
    op.drop_index("idx_push_devices_member", table_name="push_devices")
    op.drop_table("push_devices")
