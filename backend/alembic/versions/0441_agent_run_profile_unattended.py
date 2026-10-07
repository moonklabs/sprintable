"""story #4598 (E-DESKTOP-2 · 1선 · PO 10:53Z) — «묻지 않고 일하기»: one switch per agent, owners only.

agent_run_profiles.unattended — on → the desktop app starts the agent's next session in the CLI's dontAsk mode: what is allowed
beforehand runs, anything else is skipped without a question (no tool question, no phone · web card — and never bypass: the fences
stay up, PO 12:1xZ); off (the default for every row today and for a new customer) → the asking mode as before. A start argument
like model · effort: read by the same daemon call right before a start, versioned the same way (contract
`~/.sprintable-shared/mirko/4598-unattended-contract.md` v0.1 §1).
"""
import sqlalchemy as sa

from alembic import op

revision = "0441"
down_revision = "0440"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agent_run_profiles",
        sa.Column("unattended", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("agent_run_profiles", "unattended")
