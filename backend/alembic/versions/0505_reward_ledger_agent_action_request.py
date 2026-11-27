"""[SID:5041] reward_ledger.agent_action_request_id — a grant made by pressing an agent's card is made ONCE, whatever happens around the press.

An agent's `give_reward` is kept as a request a person presses; the press re-plays the stored call as that person. If the process dies between the grant and the request's bookkeeping, the person may press
again (the card then says it did not finish). The replay carries the request's id and the ledger remembers it: a second grant for the same request id returns the first row instead of paying twice —
enforced by the database (a partial unique index), not by a check that two presses could race past.

Additive and nullable: every existing row keeps NULL; the index covers only rows that have an id. Downgrade drops the index and the column.

Revision ID: 0505
Revises: 0504
Create Date: 2026-11-27
"""
from alembic import op

revision = "0505"
down_revision = "0504"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE reward_ledger ADD COLUMN IF NOT EXISTS agent_action_request_id uuid")
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_reward_ledger_agent_action_request ON reward_ledger (agent_action_request_id) WHERE agent_action_request_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_reward_ledger_agent_action_request")
    op.execute("ALTER TABLE reward_ledger DROP COLUMN IF EXISTS agent_action_request_id")
