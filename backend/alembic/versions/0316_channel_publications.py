"""story #f8f7cb0f(Phase1·마케팅운영, 페드루 PO 확定 2026-09-03) — channel_publications.

멱등 원장. UNIQUE(gate_id, version_id) — 재상신이 같은 gate를 새 버전으로 재봉인할 수
있어 gate_id 단독으론 "재승인된 새 버전"과 "이미 발행된 옛 버전"이 충돌한다.

Revision ID: 0316
Revises: 0315
Create Date: 2026-09-03

story 194acb63(#3747)의 0315(site_posts.created_by_member_id nullable+백필)가 develop에
먼저 머지될 예정이라 이 번호를 0316으로 잡는다(디디 재번호, 페드루 확認 — #3374 관례
그대로: 착수 시 실 head 재확認 후 rebase 시 renumber)."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0316"
down_revision = "0315"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "channel_publications",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("gate_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("version_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("connection_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("channel", sa.Text(), nullable=False),
        sa.Column("external_container_id", sa.Text(), nullable=True),
        sa.Column("external_id", sa.Text(), nullable=True),
        sa.Column("permalink", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="container_created"),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False,
        ),
        sa.UniqueConstraint("gate_id", "version_id", name="uq_channel_publications_gate_version"),
    )
    op.create_index("ix_channel_publications_org_id", "channel_publications", ["org_id"])


def downgrade() -> None:
    op.drop_index("ix_channel_publications_org_id", table_name="channel_publications")
    op.drop_table("channel_publications")
