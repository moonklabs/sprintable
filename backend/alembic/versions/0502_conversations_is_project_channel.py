"""[SID:5032] C2 — «a channel is a project»: mark the one room a project owns as its channel.

PO decision (story 5032): every project gets one «project channel» conversation. No new `type` value is made (the delivery, permission and list code
tell `dm` from `group` and does not know a third value — a new value would be a regression risk). The room stays `type = 'group'` and carries a mark:

- `conversations.is_project_channel boolean NOT NULL DEFAULT false` — the mark;
- partial unique index `uq_conversations_project_channel` ON conversations (project_id) WHERE is_project_channel AND project_id IS NOT NULL —
  at most ONE channel per project (two requests that both find no channel meet here: the loser reads the winner's), while any number of rooms
  that are not a channel stay allowed. A channel whose project was deleted (project_id SET NULL, 0471) leaves the index.

Additive in effect: every existing row is `false`, nothing is backfilled, no room is moved or deleted (old rooms stay as they are, beside the channel).
`ADD COLUMN ... DEFAULT <constant>` rewrites no rows on PostgreSQL 11+; `conversations` is a small table either way.

Downgrade drops the index and the column — the mark is the only thing lost (a channel room itself stays, as an ordinary group room).

Revision ID: 0502
Revises: 0501
Create Date: 2026-11-27
"""
import sqlalchemy as sa

from alembic import op

revision = "0502"
down_revision = "0501"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("is_project_channel", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.create_index(
        "uq_conversations_project_channel",
        "conversations",
        ["project_id"],
        unique=True,
        postgresql_where=sa.text("is_project_channel AND project_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_conversations_project_channel", table_name="conversations", if_exists=True)
    op.drop_column("conversations", "is_project_channel")
