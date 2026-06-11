"""270c87e6: conversation_participants.muted_at — per-대화 알림 mute.

Revision ID: 0115
Revises: 0114
Create Date: 2026-06-11

mute set=무음·null=알림 ON. 참여자 지위·가시성·메시지 수신은 불변(알림 노출만 억제).
additive·nullable — 구코드 호환. idempotent(컬럼 부재 시만 추가).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0115"
down_revision = "0114"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    cols = {c["name"] for c in insp.get_columns("conversation_participants")}
    if "muted_at" not in cols:
        op.add_column(
            "conversation_participants",
            sa.Column("muted_at", sa.DateTime(timezone=True), nullable=True),
        )


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    cols = {c["name"] for c in insp.get_columns("conversation_participants")}
    if "muted_at" in cols:
        op.drop_column("conversation_participants", "muted_at")
