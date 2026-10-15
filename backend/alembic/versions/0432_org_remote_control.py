"""story #4535 (E-DESKTOP-2 B-4) — an organization's «원격 제어» switch: off by default, turned on and off by an owner.

- organizations.remote_control_enabled_at / _by — NULL = off (every org starts off). While off, the device relay refuses every
  call (the device token stays valid), no command is made, and turning it off rejects the devices' open commands.
- org_remote_control_audit_logs: one row per change (who · on/off · when) — the publish pause's own audit table is the precedent
  (permission_audit_logs takes role changes only: its action CHECK).
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0432"
down_revision = "0431"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("organizations", sa.Column("remote_control_enabled_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("organizations", sa.Column("remote_control_enabled_by", postgresql.UUID(as_uuid=True), nullable=True))
    op.create_table(
        "org_remote_control_audit_logs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("actor_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_org_remote_control_audit_logs_org_id", "org_remote_control_audit_logs", ["org_id"])


def downgrade() -> None:
    op.drop_index("ix_org_remote_control_audit_logs_org_id", table_name="org_remote_control_audit_logs")
    op.drop_table("org_remote_control_audit_logs")
    op.drop_column("organizations", "remote_control_enabled_by")
    op.drop_column("organizations", "remote_control_enabled_at")
