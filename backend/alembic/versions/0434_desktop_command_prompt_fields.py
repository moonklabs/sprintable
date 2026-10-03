"""story #4534 (E-DESKTOP-2 B-3) — a person's [지금 지시] from the phone: the conversation its answer goes to, and when its turn's
end was told to the person who sent it (once). Contract 02d2cf71 §11 (v1.9 · v1.9.1).

- desktop_commands.conversation_id: send_prompt's conversation (the person and the agent both in it) — the daemon wraps «this
  conversation» from the signed value; the server keeps it to tell the turn's end and to show the line.
- desktop_commands.turn_end_notified_at: the turn-end notice went (once).
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0434"
down_revision = "0433"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("desktop_commands", sa.Column("conversation_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("desktop_commands", sa.Column("turn_end_notified_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("desktop_commands", "turn_end_notified_at")
    op.drop_column("desktop_commands", "conversation_id")
