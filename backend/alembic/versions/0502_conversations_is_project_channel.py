"""[SID:5032] C2 — «a channel is a project»: mark the one room a project owns as its channel.

PO decision (story 5032): every project gets one «project channel» conversation. No new `type` value is made (the delivery, permission and list code
tell `dm` from `group` and does not know a third value — a new value would be a regression risk). The room stays `type = 'group'` and carries a mark:

- `conversations.is_project_channel boolean NOT NULL DEFAULT false` — the mark;
- partial unique index `uq_conversations_project_channel` ON conversations (project_id) WHERE is_project_channel AND project_id IS NOT NULL —
  at most ONE channel per project (two requests that both find no channel meet here: the loser reads the winner's), while any number of rooms
  that are not a channel stay allowed. A channel whose project was deleted (project_id SET NULL, 0471) leaves the index.

Additive in effect: every existing row is `false`, nothing is backfilled, no room is moved or deleted (old rooms stay as they are, beside the channel).
`ADD COLUMN ... DEFAULT <constant>` rewrites no rows on PostgreSQL 11+; `conversations` is a small table either way.

The index build is a plain `CREATE UNIQUE INDEX` (env.py cannot run `CONCURRENTLY` inside a migration — `autocommit_block()` dies on the incremental deploy path, see its header; the 0217 · 0384 · 0412 · 0415 · 0468
precedent): it scans `conversations` once and blocks WRITES to the table for that scan (reads go on; sending a message waits). Both statements are `IF NOT EXISTS`, so for a large table the operator can do the two
steps by hand in a separate psql session BEFORE the deploy and the migration then finds them and does nothing:
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_project_channel boolean NOT NULL DEFAULT false;
    CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_conversations_project_channel ON conversations (project_id) WHERE is_project_channel AND project_id IS NOT NULL;

Downgrade drops the index and the column — the mark is the only thing lost (a channel room itself stays, as an ordinary group room).

Revision ID: 0502
Revises: 0501
Create Date: 2026-11-27
"""
from alembic import op

revision = "0502"
down_revision = "0501"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_project_channel boolean NOT NULL DEFAULT false")
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_project_channel ON conversations (project_id) "
        "WHERE is_project_channel AND project_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_conversations_project_channel")
    op.execute("ALTER TABLE conversations DROP COLUMN IF EXISTS is_project_channel")
