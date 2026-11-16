"""story 4972 (호스트 P1 · 승인 카드) — a permission request can carry its words as an envelope the server cannot open.

The host reports `tool` · `summary` · `workdir` · `preview` as ONE sealed envelope (kind `approval_card`: the phone's key opens it, the server
never) instead of as text. The server keeps the envelope as it came (shape and size checked, nothing read) and serves it to the phone; it is gone
from the row when the request is answered, withdrawn or past its window (the same discipline as `preview`).

- agent_permission_requests.envelope: JSONB, nullable (SQL NULL — never a JSON null). NULL on every existing row, on every row reported as text, and
  on a sealed row once its question is over.
- agent_permission_requests.sealed: bool, false by default — the row was reported sealed (it has no `tool` · `summary` as text, ever). Stays true after the
  envelope is gone, so the row remains a whole row.
- the CHECK of 0445: an answerable row keeps `input_hash` — a sealed row may let it go once its question is over (the hash of the raw input is the one
  value derived from the words that would stay) — and needs `tool` AND `summary` as text OR to be sealed; an envelope is only on a sealed row and is a JSON
  object (never a JSON null); a sealed row carries no word as text (tool · summary · workdir · host · preview) and is never at stage «confirm»; a terminal-only row is never sealed.
- The new CHECK is added NOT VALID and then validated (the old rule is dropped first, so the table is never without a rule; validation reads the table without blocking writers).
No row changes on upgrade. Downgrade keeps every sealed row — as a terminal-only card with its decision and who answered it, its hash and envelope gone — then restores the old rule.
"""
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision = "0479"
down_revision = "0478"
branch_labels = None
depends_on = None

_CHECK = "ck_agent_permission_requests_terminal_only_fields"
_NEW_RULE = (
    "(envelope IS NULL OR (sealed AND jsonb_typeof(envelope) = 'object')) AND "
    "(NOT sealed OR (tool IS NULL AND summary IS NULL AND workdir IS NULL AND host IS NULL AND (preview IS NULL OR preview = 'null'::jsonb) AND stage = 'ask')) AND ("
    "(terminal_only AND input_hash IS NULL AND NOT sealed) OR "
    "(NOT terminal_only AND (input_hash IS NOT NULL OR (sealed AND state <> 'pending')) AND ((tool IS NOT NULL AND summary IS NOT NULL) OR sealed)))"
)


def upgrade() -> None:
    op.add_column("agent_permission_requests", sa.Column("envelope", JSONB(), nullable=True))
    op.add_column("agent_permission_requests", sa.Column("sealed", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.drop_constraint(_CHECK, "agent_permission_requests", type_="check")
    op.execute(f"ALTER TABLE agent_permission_requests ADD CONSTRAINT {_CHECK} CHECK ({_NEW_RULE}) NOT VALID")
    op.execute(f"ALTER TABLE agent_permission_requests VALIDATE CONSTRAINT {_CHECK}")


def downgrade() -> None:
    op.drop_constraint(_CHECK, "agent_permission_requests", type_="check")
    # a sealed row cannot keep its shape under the old rule (no tool · summary): it stays as a terminal-only card — its state, decision and who answered it are kept
    op.execute("UPDATE agent_permission_requests SET terminal_only = true, input_hash = NULL, envelope = NULL, sealed = false WHERE sealed")
    op.create_check_constraint(
        _CHECK, "agent_permission_requests",
        "(terminal_only AND input_hash IS NULL) OR "
        "(NOT terminal_only AND input_hash IS NOT NULL AND tool IS NOT NULL AND summary IS NOT NULL)",
    )
    op.drop_column("agent_permission_requests", "sealed")
    op.drop_column("agent_permission_requests", "envelope")
