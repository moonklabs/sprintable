"""story 5027: `remote_devices.pop_verified_at` — when a phone proved it holds the private key of the key it registered

ONE nullable column, nothing else (no default, no backfill: every key that exists has not proved anything, and says so by NULL). A running old revision never reads or writes it,
so the migration is safe to run before the code that uses it. Downgrade drops the column (the proofs are a claim the server makes about a key, not data a person made).

Revision ID: 0498
Revises: 0497
"""
import sqlalchemy as sa
from alembic import op

revision = "0498"
down_revision = "0497"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("remote_devices", sa.Column("pop_verified_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("remote_devices", "pop_verified_at")
