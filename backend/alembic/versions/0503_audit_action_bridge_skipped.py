"""[SID:5049] a bridge line the mapping's project does not own leaves an audit row an organization's admin can read.

`permission_audit_logs` is the table behind `GET /api/v2/audit-logs` (and the MCP `list_audit_logs`) — the one audit list an admin reads. Its `action` column has a closed CHECK of three role-change
values (baseline/schema.sql), so a row for «an inbound external message was skipped» (`bridge.inbound_skipped`) could not be written: the insert would fail and the trace would silently never appear.
This widens the CHECK by that ONE value. Nothing else changes; every existing row already satisfies the wider list. The table is small and append-only; the new CHECK is validated against its rows once.

Downgrade removes the rows of the new action (they would violate the old CHECK) and restores the three-value list.

Revision ID: 0503
Revises: 0502
Create Date: 2026-11-27
"""
from alembic import op

revision = "0503"
down_revision = "0502"
branch_labels = None
depends_on = None

_OLD = "('member_added', 'member_removed', 'role_changed')"
_NEW = "('member_added', 'member_removed', 'role_changed', 'bridge.inbound_skipped')"


def upgrade() -> None:
    op.execute("ALTER TABLE permission_audit_logs DROP CONSTRAINT IF EXISTS permission_audit_logs_action_check")
    op.execute(f"ALTER TABLE permission_audit_logs ADD CONSTRAINT permission_audit_logs_action_check CHECK (action IN {_NEW})")


def downgrade() -> None:
    op.execute("DELETE FROM permission_audit_logs WHERE action = 'bridge.inbound_skipped'")
    op.execute("ALTER TABLE permission_audit_logs DROP CONSTRAINT IF EXISTS permission_audit_logs_action_check")
    op.execute(f"ALTER TABLE permission_audit_logs ADD CONSTRAINT permission_audit_logs_action_check CHECK (action IN {_OLD})")
