"""story 1935(급건): push_devices.platform NOT NULL→nullable. v0.2.4 앱이 platform 없이
`POST /api/v2/push/devices`를 register해 422로 막히던 실 갭 — register가 진짜로 platform을
모를 수 있게(fake default 아닌 진짜 NULL) 스키마를 완화한다. Expo Push API 자체는 payload에
platform을 안 쓰므로(ee/services/expo_push.py) 발송기 영향 없음.

Revision ID: 0197
Revises: 0196
Create Date: 2026-07-16
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0197"
down_revision = "0196"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("push_devices_platform_check", "push_devices", type_="check")
    op.alter_column("push_devices", "platform", existing_type=sa.Text(), nullable=True)
    op.create_check_constraint(
        "push_devices_platform_check", "push_devices",
        "platform IS NULL OR platform IN ('ios', 'android')",
    )


def downgrade() -> None:
    op.drop_constraint("push_devices_platform_check", "push_devices", type_="check")
    op.alter_column("push_devices", "platform", existing_type=sa.Text(), nullable=False)
    op.create_check_constraint(
        "push_devices_platform_check", "push_devices", "platform IN ('ios', 'android')",
    )
