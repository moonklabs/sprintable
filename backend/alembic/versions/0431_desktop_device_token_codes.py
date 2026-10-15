"""story #4548 (E-DESKTOP-2 B-1) — a device already set up gets its relay token by a person's confirmation, not by setting it
up again (= a new agent · a broken identity).

- desktop_device_token_codes: a short, single-use code for one existing setup (asked with that setup's own agent key), confirmed
  on the web by an owner/admin of its org, exchanged with the app's PKCE verifier for the device token alone. Only the code's
  hash and the challenge are kept.
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0431"
down_revision = "0430"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "desktop_device_token_codes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("setup_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False),
        sa.Column("code_hash", sa.Text(), nullable=False),
        sa.Column("code_challenge", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("confirmed_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("exchanged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("code_hash", name="uq_desktop_device_token_codes_code_hash"),
    )
    op.create_index("ix_desktop_device_token_codes_setup_id", "desktop_device_token_codes", ["setup_id"])


def downgrade() -> None:
    op.drop_index("ix_desktop_device_token_codes_setup_id", table_name="desktop_device_token_codes")
    op.drop_table("desktop_device_token_codes")
