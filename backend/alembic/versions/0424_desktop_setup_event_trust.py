"""story #4424 (PO 12:21Z) — the desktop setup's step events are counted only when they are proven.

- `desktop_setups.event_token_hash`: sha256 of a per-setup event token handed to the desktop app once, in the setup code
  answer. The app's step events carry it; the server compares it (constant time) with this hash.
- `onboarding_events.desktop_setup_verified`: set by the server only — true when a desktop app event carried its setup's
  token, or a web event came from a signed-in member of that setup's org. The setup status and hands reads count
  server-written rows and these; anything else is kept (for analysis) but not counted.

Revision ID: 0424
Revises: 0423
"""
import sqlalchemy as sa

from alembic import op

revision = "0424"
down_revision = "0423"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("desktop_setups", sa.Column("event_token_hash", sa.Text(), nullable=True))
    op.add_column(
        "onboarding_events",
        sa.Column("desktop_setup_verified", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("onboarding_events", "desktop_setup_verified")
    op.drop_column("desktop_setups", "event_token_hash")
