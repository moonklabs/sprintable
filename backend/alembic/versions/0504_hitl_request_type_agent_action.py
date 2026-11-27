"""[SID:5041] an agent's ask that a person must press is kept as an `agent_hitl_requests` row — widen the request_type CHECK by that ONE value.

`agent_hitl_requests_request_type_check` (set by 0124) allows approval · input · confirmation · escalation · gate_approval. The new ask (`app/services/agent_action.py`:
an agent's delete / close / grant is kept, a person presses a card, the server runs it as that person) is `request_type = 'agent_action'`, which the CHECK refused (the
insert would fail with 23514 and every park would be a 500). No new table: the row already has the columns the ask needs (agent · project · title · prompt · status ·
responded_by · expires_at · metadata).

The new CHECK is added `NOT VALID` and then validated (the same two steps as 0503): every existing row already satisfies the wider list.

Downgrade removes the rows of the new type (they would violate the old CHECK) and restores the five-value list.

Revision ID: 0504
Revises: 0503
Create Date: 2026-11-27
"""
from alembic import op

revision = "0504"
down_revision = "0503"
branch_labels = None
depends_on = None

_OLD = "ARRAY['approval', 'input', 'confirmation', 'escalation', 'gate_approval']"
_NEW = "ARRAY['approval', 'input', 'confirmation', 'escalation', 'gate_approval', 'agent_action']"


def _set(allowed: str) -> None:
    op.execute("ALTER TABLE agent_hitl_requests DROP CONSTRAINT IF EXISTS agent_hitl_requests_request_type_check")
    op.execute(f"ALTER TABLE agent_hitl_requests ADD CONSTRAINT agent_hitl_requests_request_type_check CHECK (request_type = ANY ({allowed}::text[])) NOT VALID")
    op.execute("ALTER TABLE agent_hitl_requests VALIDATE CONSTRAINT agent_hitl_requests_request_type_check")


def upgrade() -> None:
    _set(_NEW)


def downgrade() -> None:
    op.execute("DELETE FROM agent_hitl_requests WHERE request_type = 'agent_action'")
    _set(_OLD)
