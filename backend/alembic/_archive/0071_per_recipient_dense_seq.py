"""per-recipient dense commit-ordered seq — provably gap-free.

agent_event_seqs: per-recipient 카운터 (row-lock이 commit 순서 직렬화).
events.recipient_seq: 에이전트별 단조 dense seq (1,2,3...).

xmin 기반 방식 폐기 — seq=commit 순서이므로 낮은 seq 늦커밋 자체 불가.

Revision ID: 0071
Revises: 0070
Create Date: 2026-06-01
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0071"
down_revision = "0070"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    tables = set(insp.get_table_names())

    # ── 1. agent_event_seqs ───────────────────────────────────────────────────
    if "agent_event_seqs" not in tables:
        op.create_table(
            "agent_event_seqs",
            sa.Column("recipient_id", UUID(as_uuid=True), primary_key=True),
            sa.Column("last_seq", sa.BigInteger, nullable=False, server_default="0"),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
        )

    # ── 2. events.recipient_seq 컬럼 ─────────────────────────────────────────
    event_cols = {c["name"] for c in insp.get_columns("events")}
    if "recipient_seq" not in event_cols:
        op.add_column("events", sa.Column("recipient_seq", sa.BigInteger, nullable=True))

    # ── 3. (recipient_id, recipient_seq) 인덱스 ──────────────────────────────
    existing_idx = {idx["name"] for idx in insp.get_indexes("events")}
    if "ix_events_recipient_seq" not in existing_idx:
        op.create_index(
            "ix_events_recipient_seq",
            "events",
            ["recipient_id", "recipient_seq"],
        )

    # ── 4. 백필: recipient_id별 gateway_seq 순으로 1..N 부여 ─────────────────
    conn.execute(sa.text("""
        WITH ranked AS (
            SELECT id,
                   ROW_NUMBER() OVER (
                       PARTITION BY recipient_id
                       ORDER BY COALESCE(gateway_seq, 0) ASC, created_at ASC
                   ) AS rn
            FROM events
            WHERE recipient_seq IS NULL
        )
        UPDATE events e
        SET recipient_seq = ranked.rn
        FROM ranked
        WHERE e.id = ranked.id
    """))

    # ── 5. agent_event_seqs 초기값 채우기 ────────────────────────────────────
    conn.execute(sa.text("""
        INSERT INTO agent_event_seqs (recipient_id, last_seq)
        SELECT recipient_id, MAX(recipient_seq)
        FROM events
        WHERE recipient_seq IS NOT NULL
        GROUP BY recipient_id
        ON CONFLICT (recipient_id) DO UPDATE
            SET last_seq = EXCLUDED.last_seq
    """))


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    tables = set(insp.get_table_names())

    existing_idx = {idx["name"] for idx in insp.get_indexes("events")}
    if "ix_events_recipient_seq" in existing_idx:
        op.drop_index("ix_events_recipient_seq", table_name="events")

    event_cols = {c["name"] for c in insp.get_columns("events")}
    if "recipient_seq" in event_cols:
        op.drop_column("events", "recipient_seq")

    if "agent_event_seqs" in tables:
        op.drop_table("agent_event_seqs")
