"""story #4424 (PO 11:04Z) — a desktop setup's first work item is recorded on the setup row, not only in a measurement event.

`desktop_setups.work_item_id`: the story the confirmation created and published the recipe's first stage on. The status read
and the «first result» mark find the setup by this column (one indexed lookup) instead of scanning funnel events by a JSON
field — and they no longer depend on an event write that fails silently. SET NULL if the story is deleted (the setup stays).
Nullable: setups confirmed before this column have none (no backfill — the only rows are from the few hours since 0422).

Revision ID: 0423
Revises: 0422
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0423"
down_revision = "0422"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "desktop_setups",
        sa.Column(
            "work_item_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("stories.id", ondelete="SET NULL", name="fk_desktop_setups_work_item_id"), nullable=True,
        ),
    )
    op.create_index("ix_desktop_setups_work_item_id", "desktop_setups", ["work_item_id"])


def downgrade() -> None:
    op.drop_index("ix_desktop_setups_work_item_id", table_name="desktop_setups")
    op.drop_constraint("fk_desktop_setups_work_item_id", "desktop_setups", type_="foreignkey")
    op.drop_column("desktop_setups", "work_item_id")
