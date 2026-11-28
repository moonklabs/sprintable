"""[SID:5043 C10] `conversation_messages.client_nonce` + one live message per (room · sender · token) — a send that is sent again is the SAME message.

The 6d measurement of the shared browser's draft saw «two identical messages» after a send whose answer did not arrive; the live walk made it again (the answer cut on its way back, the person pressed Send
once more: two copies in the room). The web made a NEW `client_nonce` for every call and the server only echoed it. Now the web keeps the token for a re-send of the same draft, the server stores it and the partial
unique index lets ONE row stand for a (room · sender · token): the second call — also two at the same moment — is answered with the row that is there (200, the same id, nothing new made).

Additive: `add_column` of a nullable column with no default (the 0490 shape: no rewrite, no backfill); the senders that give no token (connectors, agents, old clients) have NULL and are not in the index at all.

The index build is a plain `CREATE UNIQUE INDEX` (env.py cannot run `CONCURRENTLY` inside a migration, see 0502): it scans `conversation_messages` once and blocks WRITES for that scan (reads go on; sending waits). Both statements are
`IF NOT EXISTS`, so for a large table the two steps can be run by hand in a separate psql session BEFORE the deploy and the migration then finds them and does nothing:
    ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS client_nonce varchar(64);
    CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_conversation_messages_client_nonce ON conversation_messages (conversation_id, sender_id, client_nonce) WHERE client_nonce IS NOT NULL;

Downgrade drops the index and the column — the tokens are the only thing lost (no message is touched).

Revision ID: 0509
Revises: 0508
Create Date: 2026-11-28
"""
from alembic import op

revision = "0509"
down_revision = "0508"
branch_labels = None
depends_on = None


def _index_shape_ok(indexdef: str) -> bool:
    """the index that stands under the name is the one this migration means (an `IF NOT EXISTS` must not accept a look-alike): unique · over (room · sender · token) · only where the token is set."""
    flat = " ".join(indexdef.split())
    return "UNIQUE INDEX" in flat and "(conversation_id, sender_id, client_nonce)" in flat and "WHERE (client_nonce IS NOT NULL)" in flat


def upgrade() -> None:
    op.execute("ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS client_nonce varchar(64)")
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_messages_client_nonce "
        "ON conversation_messages (conversation_id, sender_id, client_nonce) WHERE client_nonce IS NOT NULL"
    )
    got = op.get_bind().exec_driver_sql("SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_conversation_messages_client_nonce'").scalar()
    if got is None or not _index_shape_ok(got):
        raise RuntimeError(f"uq_conversation_messages_client_nonce exists but is not the index this migration means: {got!r}")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_conversation_messages_client_nonce")
    op.execute("ALTER TABLE conversation_messages DROP COLUMN IF EXISTS client_nonce")
