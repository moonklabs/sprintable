"""story 4949 — a permission request carries a preview of what a file tool is about to write or change (the Mac's masked, cut one — never the
original), so a person approving on a phone sees the lines before pressing Allow.

- agent_permission_requests.preview: JSONB, nullable. NULL on every existing row and on every row whose tool has no preview.
  Held only while the request is pending: the answer, a withdrawal and the opportunistic purge on the next report of the same
  computer set it back to NULL, and the list serves it on a pending row only — the content of a file stays on the server no longer than
  its question waits (the same discipline as `input_hash`).
No row changes on upgrade. Downgrade drops the column.
"""
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision = "0476"
down_revision = "0475"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("agent_permission_requests", sa.Column("preview", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("agent_permission_requests", "preview")
