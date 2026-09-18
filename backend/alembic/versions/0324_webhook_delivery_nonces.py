"""story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각④) —
`webhook_delivery_nonces` — signed webhook 재전송(replay) 거부 원장.

정본 §4 확定 그대로: 수신측(dev_webhook_stub.py — 실서비스에선 고객 자신의 서버지만,
dev 라이브 표본은 이 스텁)이 `(connection_id, nonce)`를 여기 기록해 같은 조합
재전송을 UNIQUE 위반(409)으로 거부한다. FK 없음(이 도메인 전체 관례, 그라운딩 §9).

Revision ID: 0324
Revises: 0323
Create Date: 2026-09-04
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0324"
down_revision = "0323"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "webhook_delivery_nonces",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("connection_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("nonce", sa.Text(), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("connection_id", "nonce", name="uq_webhook_delivery_nonces_connection_nonce"),
    )
    op.create_index(
        "ix_webhook_delivery_nonces_connection_id", "webhook_delivery_nonces", ["connection_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_webhook_delivery_nonces_connection_id", table_name="webhook_delivery_nonces")
    op.drop_table("webhook_delivery_nonces")
