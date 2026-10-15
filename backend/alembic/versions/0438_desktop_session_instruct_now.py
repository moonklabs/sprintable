"""story #4534 (E-DESKTOP-2 · PO 2026-10-05 06:30Z · Yuna · Kadir) — whether a session can take an instruction into the running turn.

- desktop_sessions.instruct_now: the daemon reports it with each state (it reads it once when the session starts — for Claude, the
  keyboard protocol that lets an instruction be submitted while it works; Codex always). The web shows [지금 지시] only when it is
  true — never a button that always fails. It hides a button and nothing more: the daemon decides again when an instruction comes
  (Kadir 06:31Z — a value outside the signature). Nullable: a daemon from before sends none (the web then hides the button too).
"""
import sqlalchemy as sa

from alembic import op

revision = "0438"
down_revision = "0437"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("desktop_sessions", sa.Column("instruct_now", sa.Boolean(), nullable=True))


def downgrade() -> None:
    op.drop_column("desktop_sessions", "instruct_now")
