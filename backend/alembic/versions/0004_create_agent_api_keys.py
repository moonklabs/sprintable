"""create agent_api_keys table

Revision ID: 0004
Revises: 0003
Create Date: 2026-05-01

C-S10: API key 인증 경로 FastAPI 전환 후 Cloud SQL에 agent_api_keys 테이블 생성.
Supabase에만 있던 테이블을 Cloud SQL prod에 추가한다.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY, UUID

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_api_keys",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("team_member_id", UUID(as_uuid=True), sa.ForeignKey("team_members.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("key_prefix", sa.Text, nullable=False),
        sa.Column("key_hash", sa.Text, nullable=False),
        sa.Column("scope", ARRAY(sa.Text), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_agent_api_keys_team_member_id", "agent_api_keys", ["team_member_id"])
    op.create_index("ix_agent_api_keys_key_hash", "agent_api_keys", ["key_hash"])


def downgrade() -> None:
    op.drop_table("agent_api_keys")
