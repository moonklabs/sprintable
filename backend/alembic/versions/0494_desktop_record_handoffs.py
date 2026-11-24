"""[SID:4978 C2] the record-key HANDOFF relay — one short-lived table that holds a SEALED `record_handoff` envelope between two paired devices until the receiver says it has it.

`desktop_record_handoffs`: one row per envelope in flight. `envelope` = the sealed envelope the server cannot open (the record key R is inside it, wrapped to ONE receiver: the server never holds a key and sees a shape and a size — always the same size, so
not even how many key generations travel). The row is addressed by the PAIR it travels on — (computer `setup_id`, phone `remote_device_id`) — and a `direction` (`host_to_phone` · `phone_to_host`); `command_id` is the envelope's own one-time id (the
sender's retry of the same envelope is no second row: UNIQUE over the pair, the direction and it). It is DELETED the moment the receiver says it has it, and anyway at `expires_at` (15 minutes after it was put: the envelope's own window is at most 10);
both foreign keys CASCADE, so a computer or a phone that goes takes what was addressed to it.

Additive only: one new table, its one CHECK pair, its UNIQUE and its three indexes — nothing existing is altered, backfilled or locked. Why a running old revision lives with it: it never names the table. Downgrade drops it (nothing outside it refers to it).

Revision ID: 0494
Revises: 0493
Create Date: 2026-11-21
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0494"
down_revision = "0493"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "desktop_record_handoffs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("setup_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False),
        sa.Column("remote_device_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("remote_devices.id", ondelete="CASCADE"), nullable=False),
        sa.Column("direction", sa.Text(), nullable=False),
        sa.Column("command_id", sa.Text(), nullable=False),
        sa.Column("envelope", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("direction IN ('host_to_phone', 'phone_to_host')", name="ck_desktop_record_handoffs_direction"),
        sa.CheckConstraint("char_length(command_id) BETWEEN 1 AND 64", name="ck_desktop_record_handoffs_command_id"),
        sa.UniqueConstraint("setup_id", "remote_device_id", "direction", "command_id", name="uq_desktop_record_handoffs_one_envelope"),
    )
    op.create_index("ix_desktop_record_handoffs_pair", "desktop_record_handoffs", ["setup_id", "remote_device_id", "direction", "created_at"])  # the computer's read and the per-pair cap
    op.create_index("ix_desktop_record_handoffs_phone", "desktop_record_handoffs", ["remote_device_id", "direction", "created_at"])  # the phone's read
    op.create_index("ix_desktop_record_handoffs_expires", "desktop_record_handoffs", ["expires_at"])


def downgrade() -> None:
    op.drop_table("desktop_record_handoffs")
