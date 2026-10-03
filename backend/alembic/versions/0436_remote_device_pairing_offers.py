"""story #4531 (E-DESKTOP-2 B-2 데스크톱) — a phone's answer to a desktop's pairing QR (contract 02d2cf71 v1.10 §10 ⑤).

- remote_device_pairing_offers: carried down as the relay frame `pairing_offer` until it expires. No secret and no MAC check on
  the server — the trust comes from the QR's secret, which only the desktop and the phone hold.
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0436"
down_revision = "0435"
branch_labels = None
depends_on = None

_UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.create_table(
        "remote_device_pairing_offers",
        sa.Column("id", _UUID, primary_key=True),
        sa.Column("setup_id", _UUID, sa.ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False),
        sa.Column("offer_id", _UUID, nullable=False),
        sa.Column("remote_device_id", _UUID, sa.ForeignKey("remote_devices.id", ondelete="CASCADE"), nullable=False),
        sa.Column("offered_by", _UUID, nullable=False),
        sa.Column("mac", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("setup_id", "offer_id", name="uq_remote_device_pairing_offers_setup_offer"),
    )
    op.create_index("ix_remote_device_pairing_offers_setup_id", "remote_device_pairing_offers", ["setup_id"])


def downgrade() -> None:
    op.drop_index("ix_remote_device_pairing_offers_setup_id", table_name="remote_device_pairing_offers")
    op.drop_table("remote_device_pairing_offers")
