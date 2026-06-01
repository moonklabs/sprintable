"""E-CAGE-REFEREE P1: verdict 테이블 생성 (participation 기반 결과 기록).

Revision ID: 0064
Revises: 0063
Create Date: 2026-05-31

verdict는 participation_id + source 쌍으로 uq — 멱등 재기록 가능.
result는 null 허용 — 미측정 시 거짓 pass/fail 금지.
공개 POST API 없음 — record_verdict() 내부 서비스 함수 전용.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0064"
down_revision = "0063"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if "verdict" in insp.get_table_names():
        return

    op.create_table(
        "verdict",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", UUID(as_uuid=True), nullable=False),
        sa.Column(
            "participation_id",
            UUID(as_uuid=True),
            sa.ForeignKey("participation.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # source: 확장 가능 String (pr|qa|ci|design — enum 하드코딩 금지)
        sa.Column("source", sa.String(50), nullable=False),
        # result: null 허용 — 미측정 시 null (거짓 pass/fail 방지)
        sa.Column("result", sa.String(20), nullable=True),
        sa.Column("rounds", sa.Integer(), nullable=True),
        sa.Column(
            "recorded_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_verdict_org_id", "verdict", ["org_id"])
    op.create_index("ix_verdict_participation_id", "verdict", ["participation_id"])
    op.create_unique_constraint(
        "uq_verdict_participation_source",
        "verdict",
        ["participation_id", "source"],
    )


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if "verdict" not in insp.get_table_names():
        return
    op.drop_constraint("uq_verdict_participation_source", "verdict", type_="unique")
    op.drop_index("ix_verdict_participation_id", table_name="verdict")
    op.drop_index("ix_verdict_org_id", table_name="verdict")
    op.drop_table("verdict")
