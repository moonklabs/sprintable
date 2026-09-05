"""story #3475(Phase1·마케팅운영, 페드루 PO 確定 2026-09-05) —
platform_settings.on_time_tolerance_seconds.

발행 계측 API의 「정시」 정의(published_at - scheduled_at <= tolerance)에 쓰는
허용오차. cron 1분 tick + 워커 처리 여유를 감안한 기본 120초 — 하드코딩·env var
금지 원칙(dunning_grace_days/vat_rate_bp와 동일 선례, AC6)에 따라 어드민 관리값
으로 둔다. mutation은 sprintable-admin/internal-api 전용(platform_setting.py
모듈 docstring 참고), 이 백엔드는 GET만.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0328"
down_revision = "0327"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "platform_settings",
        sa.Column("on_time_tolerance_seconds", sa.Integer(), nullable=False, server_default="120"),
    )
    op.create_check_constraint(
        "ck_platform_settings_on_time_tolerance_seconds_nonneg",
        "platform_settings",
        "on_time_tolerance_seconds >= 0",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_platform_settings_on_time_tolerance_seconds_nonneg", "platform_settings", type_="check",
    )
    op.drop_column("platform_settings", "on_time_tolerance_seconds")
