"""story #4632 — the flood-block stamps record the moment of the write, not the start of the transaction.

`chain_circuit_breaker.opened_at` and `conversation_messages.created_at` defaulted to `now()`, which in PostgreSQL is the start of the
writing transaction. A long transaction that opened a block or wrote a message therefore stamped it earlier than it happened, and the
auto-release check (which compares against the same clock) could release a block a little early. Both defaults move to
`clock_timestamp()`, the wall clock at the moment of the write. Existing rows are untouched; downgrade restores `now()`.
"""
from alembic import op

revision = "0448"
down_revision = "0447"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE chain_circuit_breaker ALTER COLUMN opened_at SET DEFAULT clock_timestamp()")
    op.execute("ALTER TABLE conversation_messages ALTER COLUMN created_at SET DEFAULT clock_timestamp()")


def downgrade() -> None:
    op.execute("ALTER TABLE chain_circuit_breaker ALTER COLUMN opened_at SET DEFAULT now()")
    op.execute("ALTER TABLE conversation_messages ALTER COLUMN created_at SET DEFAULT now()")
