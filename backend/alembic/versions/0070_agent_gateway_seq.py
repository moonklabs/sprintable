"""E-AGENT-GATEWAY Phase 0: gateway_seq 단조 커서 + 커서 테이블.

events.gateway_seq: BIGINT GENERATED ALWAYS AS IDENTITY (단조 불변 커서)
  - 기존 행 백필: ADD COLUMN 시 자동 채워짐
  - (recipient_id, gateway_seq) 인덱스: 에이전트 스트림 조회 최적화

agent_event_cursors: per-agent acked_seq 영속화
agent_gateway_sessions: 세션 메타 (연결 추적용)

Revision ID: 0070
Revises: 0069
Create Date: 2026-06-01
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0070"
down_revision = "0069"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)

    # ── 1. events.gateway_seq ─────────────────────────────────────────────────
    event_cols = {c["name"] for c in insp.get_columns("events")}
    if "gateway_seq" not in event_cols:
        # GENERATED ALWAYS AS IDENTITY: 기존 행에도 자동으로 순차값 채워짐 (백필)
        conn.execute(sa.text(
            "ALTER TABLE events "
            "ADD COLUMN gateway_seq BIGINT GENERATED ALWAYS AS IDENTITY"
        ))

    # (recipient_id, gateway_seq) 복합 인덱스
    existing_idx = {idx["name"] for idx in insp.get_indexes("events")}
    if "ix_events_recipient_gateway_seq" not in existing_idx:
        op.create_index(
            "ix_events_recipient_gateway_seq",
            "events",
            ["recipient_id", "gateway_seq"],
        )

    # ── 2. agent_event_cursors ────────────────────────────────────────────────
    tables = set(insp.get_table_names())
    if "agent_event_cursors" not in tables:
        op.create_table(
            "agent_event_cursors",
            sa.Column("agent_id", UUID(as_uuid=True), primary_key=True),
            sa.Column(
                "acked_seq", sa.BigInteger, nullable=False, server_default="0"
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
        )

    # ── 3. agent_gateway_sessions ─────────────────────────────────────────────
    if "agent_gateway_sessions" not in tables:
        op.create_table(
            "agent_gateway_sessions",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("agent_id", UUID(as_uuid=True), nullable=False, index=True),
            sa.Column(
                "connected_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column(
                "last_seen_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column(
                "last_ack_seq", sa.BigInteger, nullable=False, server_default="0"
            ),
        )


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    tables = set(insp.get_table_names())

    if "agent_gateway_sessions" in tables:
        op.drop_table("agent_gateway_sessions")
    if "agent_event_cursors" in tables:
        op.drop_table("agent_event_cursors")

    existing_idx = {idx["name"] for idx in insp.get_indexes("events")}
    if "ix_events_recipient_gateway_seq" in existing_idx:
        op.drop_index("ix_events_recipient_gateway_seq", table_name="events")

    event_cols = {c["name"] for c in insp.get_columns("events")}
    if "gateway_seq" in event_cols:
        conn.execute(sa.text("ALTER TABLE events DROP COLUMN gateway_seq"))
