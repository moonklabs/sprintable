"""events.gateway_seq 컬럼 + 인덱스 DROP.

recipient_seq(0071)로 대체 완료. gateway_seq GENERATED ALWAYS AS IDENTITY가
ORM INSERT 시 gateway_seq=NULL 충돌(GeneratedAlwaysError)을 유발하므로 제거.

Revision ID: 0072
Revises: 0071
Create Date: 2026-06-02
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0072"
down_revision = "0071"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)

    # 인덱스 DROP (IF EXISTS 상당)
    existing_idx = {idx["name"] for idx in insp.get_indexes("events")}
    if "ix_events_recipient_gateway_seq" in existing_idx:
        op.drop_index("ix_events_recipient_gateway_seq", table_name="events")

    # 컬럼 DROP
    event_cols = {c["name"] for c in insp.get_columns("events")}
    if "gateway_seq" in event_cols:
        conn.execute(sa.text("ALTER TABLE events DROP COLUMN gateway_seq"))


def downgrade() -> None:
    """gateway_seq 복원 — 기존 행 백필 없이 신규 행만 IDENTITY 채움."""
    conn = op.get_bind()
    insp = sa.inspect(conn)
    event_cols = {c["name"] for c in insp.get_columns("events")}
    if "gateway_seq" not in event_cols:
        conn.execute(sa.text(
            "ALTER TABLE events "
            "ADD COLUMN gateway_seq BIGINT GENERATED ALWAYS AS IDENTITY"
        ))
    existing_idx = {idx["name"] for idx in insp.get_indexes("events")}
    if "ix_events_recipient_gateway_seq" not in existing_idx:
        op.create_index(
            "ix_events_recipient_gateway_seq",
            "events",
            ["recipient_id", "gateway_seq"],
        )
