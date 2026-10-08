"""story #4590 (E-2선 · Mirko's contract v1.14 판 2 `4590-terminal-ask-contract.md` · Yuna `4590-terminal-only-card.md` · PO 23:52Z) — a
permission question that can only be answered in that computer's terminal reaches the phone and the web as a card.

The daemon keeps such questions (a window it does not know · one it cannot hand over signed) as `terminalOnly`, and until now never
reported them: the phone saw a «권한 대기» chip with nothing behind it. A terminal-only row has nothing to sign, and its tool or
summary may not have been read.

- agent_permission_requests.terminal_only: bool, false by default (every existing row is an answerable one).
- input_hash · tool · summary: nullable — and a CHECK keeps all three present on every row that is not terminal-only (the
  answerable rows' rule stays the database's), and keeps input_hash absent on a terminal-only one (nothing to sign, nothing exposed).
No row changes on upgrade. Downgrade removes the terminal-only rows first (they cannot satisfy the old NOT NULLs), then restores them.
"""
import sqlalchemy as sa

from alembic import op

revision = "0445"
down_revision = "0444"  # 4560's (limit_held)
branch_labels = None
depends_on = None

_CHECK = "ck_agent_permission_requests_terminal_only_fields"


def upgrade() -> None:
    op.add_column(
        "agent_permission_requests",
        sa.Column("terminal_only", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    for col in ("input_hash", "tool", "summary"):
        op.alter_column("agent_permission_requests", col, existing_type=sa.Text(), nullable=True)
    op.create_check_constraint(
        _CHECK, "agent_permission_requests",
        "(terminal_only AND input_hash IS NULL) OR "
        "(NOT terminal_only AND input_hash IS NOT NULL AND tool IS NOT NULL AND summary IS NOT NULL)",
    )


def downgrade() -> None:
    op.drop_constraint(_CHECK, "agent_permission_requests", type_="check")
    op.execute("DELETE FROM agent_permission_requests WHERE terminal_only")
    for col in ("input_hash", "tool", "summary"):
        op.alter_column("agent_permission_requests", col, existing_type=sa.Text(), nullable=False)
    op.drop_column("agent_permission_requests", "terminal_only")
