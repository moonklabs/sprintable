"""story #4533 (E-DESKTOP-2 B-2) — an agent's permission request goes from its desktop to the person who decides it; the phones
that can answer are recorded for showing, counting and matching a pairing (contract 02d2cf71 §9 · §10 · v1.7).

- agent_permission_requests: a masked summary of one permission prompt, its recipient (and why: paired | no_paired_phone) and
  state. A phone's signed decision is not kept — it goes down as an `answer_approval` command, carried as it is.
- remote_devices: a phone key a person registered while logged in on that phone (counted · shown · never trusted).
- remote_device_pairings: a device ↔ phone pair as the device reports it; a removal is effective at once and sent down until
  the device's snapshot drops it.
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0433"
down_revision = "0432"
branch_labels = None
depends_on = None

_UUID = postgresql.UUID(as_uuid=True)


def _tz(name: str, nullable: bool = True, now: bool = False) -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable, server_default=sa.func.now() if now else None)


def upgrade() -> None:
    op.create_table(
        "agent_permission_requests",
        sa.Column("id", _UUID, primary_key=True),
        sa.Column("setup_id", _UUID, sa.ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False),
        sa.Column("request_id", _UUID, nullable=False),
        sa.Column("session_key", sa.Text(), nullable=False),
        sa.Column("agent_member_id", _UUID, nullable=False),
        sa.Column("runtime", sa.Text(), nullable=False),
        sa.Column("tool", sa.Text(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("masked", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("truncated", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("workdir", sa.Text(), nullable=True),
        sa.Column("input_hash", sa.Text(), nullable=False),
        _tz("expires_at", nullable=False),
        sa.Column("state", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("recipient_member_id", _UUID, nullable=True),
        sa.Column("recipient_reason", sa.Text(), nullable=False),
        sa.Column("answered_by", _UUID, nullable=True),
        sa.Column("answered_phone_key_id", _UUID, nullable=True),
        sa.Column("decision", sa.Text(), nullable=True),
        _tz("answered_at"),
        sa.Column("result_code", sa.Text(), nullable=True),
        _tz("created_at", nullable=False, now=True),
        sa.UniqueConstraint("setup_id", "request_id", name="uq_agent_permission_requests_setup_request"),
        sa.CheckConstraint(
            "state IN ('pending', 'answered', 'withdrawn', 'expired', 'rejected')", name="ck_agent_permission_requests_state",
        ),
        sa.CheckConstraint("runtime IN ('claude', 'codex')", name="ck_agent_permission_requests_runtime"),
        sa.CheckConstraint(
            "decision IS NULL OR decision IN ('allow', 'deny')", name="ck_agent_permission_requests_decision",
        ),
        sa.CheckConstraint(
            "recipient_reason IN ('paired', 'no_paired_phone')", name="ck_agent_permission_requests_recipient_reason",
        ),
    )
    op.create_index(
        "ix_agent_permission_requests_recipient_state", "agent_permission_requests", ["recipient_member_id", "state"],
    )

    op.create_table(
        "remote_devices",
        sa.Column("id", _UUID, primary_key=True),
        sa.Column("member_id", _UUID, sa.ForeignKey("members.id", ondelete="CASCADE"), nullable=False),
        sa.Column("org_id", _UUID, sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("public_key", sa.Text(), nullable=False),
        sa.Column("fingerprint", sa.Text(), nullable=False),
        _tz("created_at", nullable=False, now=True),
        _tz("last_used_at"),
        _tz("revoked_at"),
        sa.UniqueConstraint("fingerprint", name="uq_remote_devices_fingerprint"),
    )
    op.create_index("ix_remote_devices_member_id", "remote_devices", ["member_id"])
    op.create_index("ix_remote_devices_org_id", "remote_devices", ["org_id"])

    op.create_table(
        "remote_device_pairings",
        sa.Column("id", _UUID, primary_key=True),
        sa.Column("remote_device_id", _UUID, sa.ForeignKey("remote_devices.id", ondelete="CASCADE"), nullable=False),
        sa.Column("setup_id", _UUID, sa.ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False),
        _tz("paired_at", nullable=False),
        _tz("reported_at", nullable=False, now=True),
        _tz("removed_at"),
        sa.Column("removed_by", _UUID, nullable=True),
        _tz("removal_acked_at"),
        sa.UniqueConstraint("remote_device_id", "setup_id", name="uq_remote_device_pairings_device_setup"),
    )
    op.create_index("ix_remote_device_pairings_setup_id", "remote_device_pairings", ["setup_id"])


def downgrade() -> None:
    op.drop_index("ix_remote_device_pairings_setup_id", table_name="remote_device_pairings")
    op.drop_table("remote_device_pairings")
    op.drop_index("ix_remote_devices_org_id", table_name="remote_devices")
    op.drop_index("ix_remote_devices_member_id", table_name="remote_devices")
    op.drop_table("remote_devices")
    op.drop_index("ix_agent_permission_requests_recipient_state", table_name="agent_permission_requests")
    op.drop_table("agent_permission_requests")
