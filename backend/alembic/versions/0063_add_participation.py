"""E-CAGE-REFEREE P1: participation_role + participation 테이블 생성 및 assignee 백필.

Revision ID: 0063
Revises: 0062
Create Date: 2026-05-31

assignee(주책임 1명)는 그대로 유지 — participation(역할별 N명)을 다대다로 추가.
participation_role: 조직 커스텀 역할(enum 하드코딩 금지, 범용).
기본 시드: 구현(is_default)·PO·QA·디자인·DevOps.
백필: 기존 assignee_id 있는 스토리 → default role로 participation 1건(멱등).
"""
from __future__ import annotations

import uuid

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0063"
down_revision = "0062"
branch_labels = None
depends_on = None

_DEFAULT_ROLES = [
    ("implementation", "구현", True),
    ("po", "PO", False),
    ("qa", "QA", False),
    ("design", "디자인", False),
    ("devops", "DevOps", False),
]


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    existing = insp.get_table_names()

    if "participation_role" not in existing:
        op.create_table(
            "participation_role",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("org_id", UUID(as_uuid=True), nullable=False),
            sa.Column("key", sa.String(50), nullable=False),
            sa.Column("label", sa.Text(), nullable=False),
            sa.Column("is_default", sa.Boolean(), nullable=False, server_default="false"),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
        )
        op.create_index("ix_participation_role_org_id", "participation_role", ["org_id"])
        op.create_unique_constraint(
            "uq_participation_role_org_key",
            "participation_role",
            ["org_id", "key"],
        )

    if "participation" not in existing:
        op.create_table(
            "participation",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("org_id", UUID(as_uuid=True), nullable=False),
            sa.Column(
                "story_id",
                UUID(as_uuid=True),
                sa.ForeignKey("stories.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "member_id",
                UUID(as_uuid=True),
                sa.ForeignKey("team_members.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "role_id",
                UUID(as_uuid=True),
                sa.ForeignKey("participation_role.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
        )
        op.create_index("ix_participation_org_id", "participation", ["org_id"])
        op.create_index("ix_participation_story_id", "participation", ["story_id"])
        op.create_index("ix_participation_member_id", "participation", ["member_id"])
        op.create_unique_constraint(
            "uq_participation_story_member_role",
            "participation",
            ["story_id", "member_id", "role_id"],
        )

    # 조직별 기본 역할 시드 (org_id 목록은 stories 테이블에서 수집)
    org_rows = conn.execute(
        sa.text("SELECT DISTINCT org_id FROM stories")
    ).fetchall()

    for (org_id,) in org_rows:
        for key, label, is_default in _DEFAULT_ROLES:
            existing_role = conn.execute(
                sa.text(
                    "SELECT id FROM participation_role WHERE org_id = :org_id AND key = :key"
                ),
                {"org_id": str(org_id), "key": key},
            ).fetchone()
            if existing_role is None:
                conn.execute(
                    sa.text(
                        "INSERT INTO participation_role (id, org_id, key, label, is_default) "
                        "VALUES (:id, :org_id, :key, :label, :is_default)"
                    ),
                    {
                        "id": str(uuid.uuid4()),
                        "org_id": str(org_id),
                        "key": key,
                        "label": label,
                        "is_default": is_default,
                    },
                )

    # assignee 백필 — 멱등 (이미 participation 있는 스토리 스킵)
    stories = conn.execute(
        sa.text(
            "SELECT id, org_id, assignee_id FROM stories "
            "WHERE assignee_id IS NOT NULL AND deleted_at IS NULL"
        )
    ).fetchall()

    for (story_id, org_id, assignee_id) in stories:
        default_role = conn.execute(
            sa.text(
                "SELECT id FROM participation_role "
                "WHERE org_id = :org_id AND is_default = true LIMIT 1"
            ),
            {"org_id": str(org_id)},
        ).fetchone()
        if default_role is None:
            continue

        role_id = default_role[0]
        already = conn.execute(
            sa.text(
                "SELECT 1 FROM participation "
                "WHERE story_id = :story_id AND member_id = :member_id AND role_id = :role_id"
            ),
            {"story_id": str(story_id), "member_id": str(assignee_id), "role_id": str(role_id)},
        ).fetchone()
        if already is None:
            conn.execute(
                sa.text(
                    "INSERT INTO participation (id, org_id, story_id, member_id, role_id) "
                    "VALUES (:id, :org_id, :story_id, :member_id, :role_id)"
                ),
                {
                    "id": str(uuid.uuid4()),
                    "org_id": str(org_id),
                    "story_id": str(story_id),
                    "member_id": str(assignee_id),
                    "role_id": str(role_id),
                },
            )


def downgrade() -> None:
    op.drop_constraint("uq_participation_story_member_role", "participation", type_="unique")
    op.drop_index("ix_participation_member_id", table_name="participation")
    op.drop_index("ix_participation_story_id", table_name="participation")
    op.drop_index("ix_participation_org_id", table_name="participation")
    op.drop_table("participation")

    op.drop_constraint("uq_participation_role_org_key", "participation_role", type_="unique")
    op.drop_index("ix_participation_role_org_id", table_name="participation_role")
    op.drop_table("participation_role")
