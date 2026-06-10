"""doc_share_tokens — 문서 공유 공개 URL 토큰 (Part B b1574f5a).

opaque token(슬러그 무관)·문서당 1 active(partial unique). doc_id FK 는 0107 의 docs_pkey 위.
공개 read 는 `/api/v2/public/docs/{token}` 가 active 토큰 해소(404 unknown / 410 revoked).

Revision ID: 0108
Revises: 0107
Create Date: 2026-06-10
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0108"
down_revision = "0107"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "doc_share_tokens",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "doc_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("docs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("token", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="active"),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("token", name="uq_doc_share_tokens_token"),
    )
    op.create_index("ix_doc_share_tokens_doc_id", "doc_share_tokens", ["doc_id"])
    op.create_index("ix_doc_share_tokens_token", "doc_share_tokens", ["token"])
    # 문서당 active 토큰 1개 보장 (regenerate/disable 은 직전 active 를 revoked 로 전환)
    op.create_index(
        "uq_doc_share_tokens_active",
        "doc_share_tokens",
        ["doc_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )
    op.alter_column("doc_share_tokens", "status", server_default=None)


def downgrade() -> None:
    op.drop_table("doc_share_tokens")
