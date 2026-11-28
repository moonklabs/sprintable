"""[SID:5043 C10] `conversation_message_nonces` — one live message per (room · sender · token): a send that is sent again is the SAME message.

The 6d measurement of the shared browser's draft saw «two identical messages» after a send whose answer did not arrive; the live walk made it again (the answer cut on its way back, the person pressed Send once more: two copies
in the room). The web made a NEW `client_nonce` for every call and the server only echoed it. Now the web keeps the token for a re-send of the same draft, the server stores it, and the table's primary key lets ONE row stand for
a (room · sender · token): the second call — also two at the same moment — is answered with the message that row names (200, the same id, nothing new made).

A TABLE OF ITS OWN, not a column and a unique index on `conversation_messages`: the new table is born empty, so this migration neither scans nor locks the big table (a unique index over `conversation_messages` is built by a
scan that blocks writes — and `CREATE INDEX CONCURRENTLY` cannot be used in a migration here: env.py runs without transaction_per_migration and `autocommit_block()` dies on the incremental deploy path, story 2330 · 0217, which
the CI guard enforces). The two foreign keys are added to an empty table: a brief lock on `conversations` and `conversation_messages`, no scan. No manual step before the deploy.

`conversation_id` is the room the send was ASKED of (a DM send that forks a group is stored in the fork; its token is still found where it was asked). Senders that give no token (connectors · agents · old clients) have no row.
Deleting a message (hard) or a room takes its rows with it (ON DELETE CASCADE); soft-deleted messages keep theirs (the replay of a deleted message is its empty shell).

Downgrade drops the table — the tokens are the only thing lost (no message is touched).

Revision ID: 0509
Revises: 0508
Create Date: 2026-11-28
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0509"
down_revision = "0508"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "conversation_message_nonces",
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("sender_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("client_nonce", sa.String(length=64), nullable=False),
        sa.Column("message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("content_sha256", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("clock_timestamp()"), nullable=False),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["message_id"], ["conversation_messages.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("conversation_id", "sender_id", "client_nonce", name="pk_conversation_message_nonces"),
    )
    op.create_index("ix_conversation_message_nonces_message_id", "conversation_message_nonces", ["message_id"])


def downgrade() -> None:
    op.drop_index("ix_conversation_message_nonces_message_id", table_name="conversation_message_nonces")
    op.drop_table("conversation_message_nonces")
