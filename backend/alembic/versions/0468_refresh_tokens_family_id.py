"""[SID:4782] (third PR · PO 10-26) — a sign-in's refresh tokens know their family: one nullable uuid on `refresh_tokens`.

A session's tokens form a lineage: every refresh rotates the token and the old row points at its successor (`replaced_by`). Two refreshes with the SAME cookie inside the rotation grace window
(two tabs · two pods, §2449) split it: the winner is linked from the old token, the loser's new token is an independent fork that nothing points at. Logging the session out walks `replaced_by`
(forward without a clock, backward bounded by the rotation window), so it reached the winner's line and missed the fork — and the other way round — and a stolen token that forked once
survived the owner's logout for 30 days.

- family_id  UUID — the id of the sign-in's first token; every rotation (winner · loser fork · switch of org / project / account) inherits its parent's value. A logout, a lost phone's
                    removal: `WHERE user_id = :person AND family_id = :family` ends the whole family in one statement — no walk, no hop cap, no clock.
                    NULL = a row made before this migration that has not rotated since (the first rotation of such a row starts its family at that row: it names itself and its successor) — the walks of the second PR still cover the ones before.

Additive only: no backfill (a family cannot be reconstructed for the forks that already exist — nothing points at them; the rows expire by themselves, at the latest 30 days after the last
sign-in or rotation). A PARTIAL index shaped like the statement that uses it — (user_id, family_id) over the rows that carry a family — keeps it off the table's older rows.

The index build is a plain `CREATE INDEX` (env.py cannot run `CONCURRENTLY` inside a migration — see its header; the 0217 · 0384 · 0412 · 0415 precedent): it scans `refresh_tokens` once and blocks WRITES to the table
for that scan (reads go on; sign-ins and refreshes wait). The column add itself is instant (nullable, no default). Both statements are `IF NOT EXISTS`, so for a table of a few million rows the operator can do the
two steps by hand in a separate psql session BEFORE the deploy, and the migration then finds them and does nothing:
    ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS family_id uuid;
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_refresh_tokens_user_family ON refresh_tokens (user_id, family_id) WHERE family_id IS NOT NULL;
The PR text carries the read-only row count query for the operator to decide.
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0468"
down_revision = "0467"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("refresh_tokens", sa.Column("family_id", postgresql.UUID(as_uuid=True), nullable=True), if_not_exists=True)
    op.create_index("ix_refresh_tokens_user_family", "refresh_tokens", ["user_id", "family_id"], postgresql_where=sa.text("family_id IS NOT NULL"), if_not_exists=True)


def downgrade() -> None:
    op.drop_index("ix_refresh_tokens_user_family", table_name="refresh_tokens", if_exists=True)
    op.drop_column("refresh_tokens", "family_id", if_exists=True)
