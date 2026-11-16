"""story 4972 (호스트 P1 · 승인 카드) — a permission request can carry its words as an envelope the server cannot open.

The host reports `tool` · `summary` · `workdir` · `preview` as ONE sealed envelope (kind `approval_card`: the phone's key opens it, the server
never) instead of as text. The server keeps the envelope as it came (shape and size checked, nothing read) and serves it to the phone; it is gone
from the row when the request is answered, withdrawn or past its window (the same discipline as `preview`).

- agent_permission_requests.envelope: JSONB, nullable (SQL NULL — never a JSON null). NULL on every existing row, on every row reported as text, and
  on a sealed row once its question is over.
- agent_permission_requests.sealed: bool, false by default — the row was reported sealed (it has no `tool` · `summary` as text, ever). Stays true after the
  envelope is gone, so the row remains a whole row.
- the CHECK of 0445: an answerable row keeps `input_hash`, and needs `tool` AND `summary` as text OR to be sealed; an envelope is only on a sealed row and is a JSON object (never a JSON null);
  a sealed row carries no word as text (tool · summary · workdir · host · preview); a terminal-only row is never sealed.
No row changes on upgrade. Downgrade removes the sealed rows (they cannot satisfy the old rule), then restores it.
"""
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision = "0479"
down_revision = "0478"
branch_labels = None
depends_on = None

_CHECK = "ck_agent_permission_requests_terminal_only_fields"


def upgrade() -> None:
    op.add_column("agent_permission_requests", sa.Column("envelope", JSONB(), nullable=True))
    op.add_column("agent_permission_requests", sa.Column("sealed", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.drop_constraint(_CHECK, "agent_permission_requests", type_="check")
    op.create_check_constraint(
        _CHECK, "agent_permission_requests",
        "(envelope IS NULL OR (sealed AND jsonb_typeof(envelope) = 'object')) AND "
        "(NOT sealed OR (tool IS NULL AND summary IS NULL AND workdir IS NULL AND host IS NULL AND (preview IS NULL OR preview = 'null'::jsonb))) AND ("
        "(terminal_only AND input_hash IS NULL AND NOT sealed) OR "
        "(NOT terminal_only AND input_hash IS NOT NULL AND ((tool IS NOT NULL AND summary IS NOT NULL) OR sealed)))",
    )


def downgrade() -> None:
    op.drop_constraint(_CHECK, "agent_permission_requests", type_="check")
    op.execute("DELETE FROM agent_permission_requests WHERE sealed")
    op.create_check_constraint(
        _CHECK, "agent_permission_requests",
        "(terminal_only AND input_hash IS NULL) OR "
        "(NOT terminal_only AND input_hash IS NOT NULL AND tool IS NOT NULL AND summary IS NOT NULL)",
    )
    op.drop_column("agent_permission_requests", "sealed")
    op.drop_column("agent_permission_requests", "envelope")
