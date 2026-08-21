"""story #2907(선생님 확定 2026-08-21) — platform_settings.dunning_grace_days.

grace 기간(재시도 일수)을 하드코딩하지 않는다(AC6 — 문안·금액·기간 등 가변값은 어드민
관리 원칙). 기본값 7(선생님 확定 cadence)로 시드 — billing_scheduler.py가 이 값으로
재시도 창(D+1..D+grace_days)과 downgrade 트리거일(D+grace_days+1)을 파생한다."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0269"
down_revision = "0268"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "platform_settings",
        sa.Column("dunning_grace_days", sa.Integer(), nullable=False, server_default="7"),
    )
    op.create_check_constraint(
        "ck_platform_settings_dunning_grace_days_positive",
        "platform_settings",
        "dunning_grace_days > 0",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_platform_settings_dunning_grace_days_positive", "platform_settings", type_="check",
    )
    op.drop_column("platform_settings", "dunning_grace_days")
