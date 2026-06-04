"""add story_assignees join table

E-BOARD S5: 복수 assignee. story_assignees(story_id, member_id, org_id) join 테이블 추가.
기존 stories.assignee_id(단일 주담당)는 **유지** — drop/NOT-NULL 금지(prod 구코드 호환).
additive(신규 테이블)라 공유 dev/prod DB에서 breaking 아님.

member_id는 grant-only 휴먼(org_member.id) 허용 위해 FK 미부착 (assignee_id와 동형).

Revision ID: 0094
Revises: 0093
Create Date: 2026-06-04
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0094"
down_revision = "0093"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "story_assignees",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", UUID(as_uuid=True), nullable=False),
        sa.Column(
            "story_id",
            UUID(as_uuid=True),
            sa.ForeignKey("stories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("member_id", UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.UniqueConstraint("story_id", "member_id", name="uq_story_assignees_story_member"),
    )
    op.create_index("ix_story_assignees_org_id", "story_assignees", ["org_id"])
    op.create_index("ix_story_assignees_story_id", "story_assignees", ["story_id"])
    op.create_index("ix_story_assignees_member_id", "story_assignees", ["member_id"])


def downgrade() -> None:
    op.drop_index("ix_story_assignees_member_id", table_name="story_assignees")
    op.drop_index("ix_story_assignees_story_id", table_name="story_assignees")
    op.drop_index("ix_story_assignees_org_id", table_name="story_assignees")
    op.drop_table("story_assignees")
