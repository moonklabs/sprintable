"""agent message policy mode + allowlist

E-MSG-POLICY S1: 공용 에이전트 메시징 정책. team_members에 message_policy_mode
(creator_only default | org_wide | list) 추가 + agent_message_allowlist 테이블 신설.

additive(컬럼 NOT NULL + server_default 'creator_only' → 기존 에이전트 백필=현행 동작 불변,
신규 테이블)라 공유 dev/prod DB에서 breaking 아님. 기존 코드는 새 컬럼/테이블 미참조.

⚠️ 스키마 추가 — deploy-before-migrate 주의. 머지 직후 윈도우0 pre-apply(migrate-dev 잡 선행).

Revision ID: 0096
Revises: 0095
Create Date: 2026-06-04
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0096"
down_revision = "0095"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1) agent DM 정책 모드 (기존 행 = creator_only 백필 → 동작 불변)
    op.add_column(
        "team_members",
        sa.Column(
            "message_policy_mode",
            sa.Text(),
            nullable=False,
            server_default="creator_only",
        ),
    )
    # 2) list 모드 허용 대상
    op.create_table(
        "agent_message_allowlist",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("agent_member_id", UUID(as_uuid=True), nullable=False),
        sa.Column("allowed_id", UUID(as_uuid=True), nullable=False),
        sa.Column("org_id", UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("agent_member_id", "allowed_id", name="uq_agent_message_allowlist_pair"),
    )
    op.create_index(
        "ix_agent_message_allowlist_agent", "agent_message_allowlist", ["agent_member_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_agent_message_allowlist_agent", table_name="agent_message_allowlist")
    op.drop_table("agent_message_allowlist")
    op.drop_column("team_members", "message_policy_mode")
