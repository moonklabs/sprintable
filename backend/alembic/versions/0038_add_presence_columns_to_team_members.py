"""add presence columns to team_members (S2-1)

Revision ID: 0038
Revises: 0037
Create Date: 2026-05-19
"""
import sqlalchemy as sa
from alembic import op

revision = "0038"
down_revision = "0037"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # AC2: last_seen_at TIMESTAMPTZ NULL — passive heartbeat 기록
    op.add_column(
        "team_members",
        sa.Column("last_seen_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    # AC3: active_story_id UUID NULL — FK는 아래에서 create_foreign_key로 별도 추가
    op.add_column(
        "team_members",
        sa.Column("active_story_id", sa.UUID(as_uuid=True), nullable=True),
    )
    # AC4: agent_status VARCHAR(20) NULL — online/idle/offline
    op.add_column(
        "team_members",
        sa.Column("agent_status", sa.String(20), nullable=True),
    )

    # dev bootstrap 시 stories.id PK constraint가 누락된 환경 대응
    # prod(Supabase 원본)에는 PK가 존재하므로 DO $$ 블록이 no-op 처리됨
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'stories_pkey'
                  AND conrelid = 'stories'::regclass
            ) THEN
                ALTER TABLE stories ADD PRIMARY KEY (id);
            END IF;
        END $$;
        """
    )

    # AC3: active_story_id → stories.id ON DELETE SET NULL
    op.create_foreign_key(
        "fk_team_members_active_story_id_stories",
        "team_members",
        "stories",
        ["active_story_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_team_members_active_story_id_stories", "team_members", type_="foreignkey")
    op.drop_column("team_members", "agent_status")
    op.drop_column("team_members", "active_story_id")
    op.drop_column("team_members", "last_seen_at")
