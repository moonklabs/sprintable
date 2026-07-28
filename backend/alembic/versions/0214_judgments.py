"""story #2268(D단계, E-CONNECT — "판단 칸") — judgments 테이블 신설.

순수 additive — 신규 테이블뿐, 기존 테이블/데이터 손상 0. `app/models/judgment.py` 모듈
docstring에 전체 설계 배경(두 층·work_item_ids 셋 근거·scope 명시화 이유) 있음.

Revision ID: 0214
Revises: 0213
Create Date: 2026-07-29
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0214"
down_revision = "0213"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "judgments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("scope", sa.String(20), nullable=False),
        sa.Column(
            "work_item_ids", postgresql.ARRAY(postgresql.UUID(as_uuid=True)),
            nullable=False, server_default="{}",
        ),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("target_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("method", sa.Text(), nullable=True),
        sa.Column("statement", sa.Text(), nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint(
            "kind IN ('judgment', 'method_error', 'refinement', 'retraction', 'unmeasurable')",
            name="ck_judgments_kind",
        ),
        sa.CheckConstraint("scope IN ('general', 'items')", name="ck_judgments_scope"),
        sa.CheckConstraint(
            "(scope = 'general' AND work_item_ids = '{}') OR "
            "(scope = 'items' AND work_item_ids <> '{}')",
            name="ck_judgments_scope_work_item_ids_pairing",
        ),
        sa.CheckConstraint(
            "(kind NOT IN ('retraction', 'refinement', 'method_error')) OR (target_id IS NOT NULL)",
            name="ck_judgments_target_required_for_meta_kinds",
        ),
        sa.ForeignKeyConstraint(["target_id"], ["judgments.id"], name="fk_judgments_target_id_judgments"),
    )
    op.create_index("ix_judgments_org", "judgments", ["org_id"])
    op.create_index(
        "ix_judgments_work_item_ids", "judgments", ["work_item_ids"], postgresql_using="gin",
    )
    op.create_index("ix_judgments_target", "judgments", ["target_id"])
    op.create_index("ix_judgments_method", "judgments", ["org_id", "method"])


def downgrade() -> None:
    op.drop_index("ix_judgments_method", table_name="judgments")
    op.drop_index("ix_judgments_target", table_name="judgments")
    op.drop_index("ix_judgments_work_item_ids", table_name="judgments")
    op.drop_index("ix_judgments_org", table_name="judgments")
    op.drop_table("judgments")
