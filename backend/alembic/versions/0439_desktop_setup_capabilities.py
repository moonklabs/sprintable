"""story #4576 (E-DESKTOP-2 · PO 2026-10-06 04:24Z) — what the desktop app that made a setup code can take.

- desktop_setups.capabilities: the app names them when it asks for a code (today one: «move» — it can take a move's exchange, whose
  agents carry no recipe role or stages). The web offers «옮기기» only for a setup that has it, and the server refuses a move
  confirmation for one that does not (an app from before reads such an exchange as malformed and stays offline). Nullable: a code
  from an app before this names none.
"""
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision = "0439"
down_revision = "0438"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("desktop_setups", sa.Column("capabilities", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("desktop_setups", "capabilities")
