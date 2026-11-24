"""story 4993 (P3b): desktop_direct_counts — a computer's own running totals of its same-network direct road (commands taken · doors opened), per run of the host

ONE NEW TABLE and nothing else: no existing table, column, constraint or row is touched. A running old revision never names it, so it lives with the new schema. The table holds numbers only (no command, no phone,
no address); a row hangs from the computer by a cascading foreign key, and the minute job takes the ones not reported for 30 days.

Revision ID: 0496
Revises: 0495
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0496"
down_revision = "0495"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "desktop_direct_counts",
        sa.Column("setup_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("desktop_setups.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("epoch", sa.String(64), primary_key=True),
        sa.Column("commands", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("doors", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("commands >= 0 AND doors >= 0", name="ck_desktop_direct_counts_nonneg"),
    )
    op.create_index("ix_desktop_direct_counts_updated_at", "desktop_direct_counts", ["updated_at"])


def downgrade() -> None:
    op.drop_index("ix_desktop_direct_counts_updated_at", table_name="desktop_direct_counts")
    op.drop_table("desktop_direct_counts")
