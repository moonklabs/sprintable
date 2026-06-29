"""E-STORAGE-SSOT S8 Phase 2: org_subscriptions.storage_warn_notified_at — 80% 경고 메일 dedup.

Revision ID: 0141
Revises: 0140
Create Date: 2026-06-28

80% storage 경고 메일을 매 cron tick 마다 재발송하지 않도록 org 단위 last-notified 마커. cron 이
보내기 前 (NULL 또는 cooldown 경과) 확인·발송 後 갱신. nullable(미발송=NULL). idempotent·fresh-runnable.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "0141"
down_revision = "0140"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in inspect(bind).get_columns("org_subscriptions")}
    if "storage_warn_notified_at" not in cols:
        op.add_column(
            "org_subscriptions",
            sa.Column("storage_warn_notified_at", sa.DateTime(timezone=True), nullable=True),
        )


def downgrade() -> None:
    op.drop_column("org_subscriptions", "storage_warn_notified_at")
