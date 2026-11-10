"""[SID:4846] a conversation can live without a project; a chat event row too.

The chat becomes one list per organization: a room is the organization's, its project is a label. So

- `conversations.project_id` may be NULL, and deleting a project no longer deletes its rooms (FK `ON DELETE CASCADE` → `SET NULL`);
- `events.project_id` may be NULL (the chat event rows of a room without a project); its FK stays `ON DELETE CASCADE`;
- an index on the organization alone for the organization-wide room list.

Additive in effect: no row is changed, nothing is backfilled, no data is deleted.

Downgrade is only possible while no such row exists: with a room or an event without a project the column cannot be NOT NULL again, and the
migration says so instead of deleting or inventing a project for them.
"""
from alembic import op

revision = "0471"
down_revision = "0470"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("conversations", "project_id", nullable=True)
    # written with `op.drop_constraint` / `op.create_foreign_key` so the promotion's migration reading (CUTOVER-prod G1a) lists the swap; `conversations` is a small table
    op.drop_constraint("conversations_project_id_fkey", "conversations", type_="foreignkey")
    op.create_foreign_key(
        "conversations_project_id_fkey", "conversations", "projects", ["project_id"], ["id"], ondelete="SET NULL",
    )
    op.alter_column("events", "project_id", nullable=True)
    op.create_index("ix_conversations_org_updated", "conversations", ["org_id", "updated_at"], if_not_exists=True)


def downgrade() -> None:
    bind = op.get_bind()
    for table in ("conversations", "events"):
        # EXISTS stops at the first such row (no count over a large table)
        if bind.exec_driver_sql(f"SELECT EXISTS (SELECT 1 FROM {table} WHERE project_id IS NULL)").scalar():
            raise RuntimeError(
                f"cannot downgrade 0471: a row of {table} has no project (project_id IS NULL) — "
                "the column cannot be NOT NULL again; give such rows a project or remove them first"
            )
    op.drop_index("ix_conversations_org_updated", table_name="conversations", if_exists=True)
    op.alter_column("events", "project_id", nullable=False)
    op.drop_constraint("conversations_project_id_fkey", "conversations", type_="foreignkey")
    op.create_foreign_key(
        "conversations_project_id_fkey", "conversations", "projects", ["project_id"], ["id"], ondelete="CASCADE",
    )
    op.alter_column("conversations", "project_id", nullable=False)
