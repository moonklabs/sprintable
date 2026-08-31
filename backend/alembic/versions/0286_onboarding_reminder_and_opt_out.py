"""story #3159(retention·최소층) — 미완주 리마인드 메일 중복방지 + 수신거부.

onboarding_events(#3157/OB-4 canonical 11종 카탈로그) 위에 이 발송 이력을 얹지 않는다 —
그 카탈로그는 measurement contract가 관리하는 고정 vocab이라, 무관한 발송 부기를 얹으면
계약 오염이다. 대신 users에 전용 컬럼 2개(발송 이력 1 + 수신거부 1) 신설 — 최소 additive.

Revision ID: 0286
Revises: 0285
Create Date: 2026-08-27

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0286"
down_revision = "0285"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("onboarding_reminder_sent_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "users",
        sa.Column("marketing_email_opt_out", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("users", "marketing_email_opt_out")
    op.drop_column("users", "onboarding_reminder_sent_at")
