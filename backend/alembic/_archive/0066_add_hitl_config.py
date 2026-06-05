"""E-CAGE-REFEREE P3: HITL gate config 테이블 (org_gate_policy + overrides).

Revision ID: 0066
Revises: 0065
Create Date: 2026-05-31

설계 원칙: 플랫폼은 위험도 판정 안 함 — risk_level 없음.
조직 posture(보수|균형|허용) + role 오버라이드 + member 예외로 disposition 결정.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0066"
down_revision = "0065"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    existing = insp.get_table_names()

    if "org_gate_policy" not in existing:
        op.create_table(
            "org_gate_policy",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("org_id", UUID(as_uuid=True), nullable=False, unique=True),
            sa.Column(
                "posture",
                sa.String(20),
                nullable=False,
                server_default="balanced",
            ),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
        )
        op.create_index("ix_org_gate_policy_org_id", "org_gate_policy", ["org_id"])

    if "org_gate_override" not in existing:
        op.create_table(
            "org_gate_override",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("org_id", UUID(as_uuid=True), nullable=False),
            sa.Column(
                "role_id",
                UUID(as_uuid=True),
                sa.ForeignKey("participation_role.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("gate_type", sa.String(50), nullable=False),
            sa.Column("disposition", sa.String(20), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
        )
        op.create_index("ix_org_gate_override_org_id", "org_gate_override", ["org_id"])
        op.create_unique_constraint(
            "uq_org_gate_override",
            "org_gate_override",
            ["org_id", "role_id", "gate_type"],
        )

    if "member_gate_override" not in existing:
        op.create_table(
            "member_gate_override",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("org_id", UUID(as_uuid=True), nullable=False),
            sa.Column(
                "member_id",
                UUID(as_uuid=True),
                sa.ForeignKey("team_members.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("gate_type", sa.String(50), nullable=False),
            sa.Column("disposition", sa.String(20), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
        )
        op.create_index("ix_member_gate_override_org_id", "member_gate_override", ["org_id"])
        op.create_unique_constraint(
            "uq_member_gate_override",
            "member_gate_override",
            ["org_id", "member_id", "gate_type"],
        )


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    existing = insp.get_table_names()

    if "member_gate_override" in existing:
        op.drop_constraint("uq_member_gate_override", "member_gate_override", type_="unique")
        op.drop_index("ix_member_gate_override_org_id", table_name="member_gate_override")
        op.drop_table("member_gate_override")

    if "org_gate_override" in existing:
        op.drop_constraint("uq_org_gate_override", "org_gate_override", type_="unique")
        op.drop_index("ix_org_gate_override_org_id", table_name="org_gate_override")
        op.drop_table("org_gate_override")

    if "org_gate_policy" in existing:
        op.drop_index("ix_org_gate_policy_org_id", table_name="org_gate_policy")
        op.drop_table("org_gate_policy")
