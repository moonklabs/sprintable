"""story 4979 — the device's own «heard from» times: `last_heard_at` and `last_presence_at`.

`desktop_device_tokens.last_used_at` is stamped by the SERVER too (its 30-second tick on an open stream), so for a computer that fell silent with its connection half open it stays fresh until the stream's
lifetime ends (measured 11-18: ≈3.3 min after the silence, up to 5 min 20 s). Two new nullable columns, written only by what the DEVICE sends:
- `last_heard_at` — the newest time the device itself spoke (connect · a report or an ack · its `presence`);
- `last_presence_at` — the newest `presence` it sent (a device whose host version sends none keeps NULL here and keeps the old rule).
Both NULL until a device speaks after this migration. Nothing is backfilled (an old `last_used_at` cannot be told from a server tick). Adding a nullable column without a default is a catalog-only change in PG 11+.
Downgrade drops them.
"""
import sqlalchemy as sa
from alembic import op

revision = "0485"
down_revision = "0484"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("desktop_device_tokens", sa.Column("last_heard_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("desktop_device_tokens", sa.Column("last_presence_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("desktop_device_tokens", "last_presence_at")
    op.drop_column("desktop_device_tokens", "last_heard_at")
