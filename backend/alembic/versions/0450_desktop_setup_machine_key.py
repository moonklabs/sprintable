"""story 4660 (design 4660 · PO 결정 · 까디르 렌즈 conditional pass) — a new setup on the same machine closes the old lines.

- desktop_setups gets two nullable columns: `machine_key` (HMAC of the org and the app's machine id, set at exchange) and
  `revoked_reason` (a closed text, e.g. «새 셋업으로 대체»; null for a person's disconnect).
- An index on (org_id, machine_key) for the exchange lookup.
- Additive only: no backfill, no existing row changes. Old rows keep a null machine_key and are never closed by this rule.
"""
import sqlalchemy as sa

from alembic import op

revision = "0450"
down_revision = "0449"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("desktop_setups", sa.Column("machine_key", sa.Text(), nullable=True))
    op.add_column("desktop_setups", sa.Column("revoked_reason", sa.Text(), nullable=True))
    op.create_index("ix_desktop_setups_org_machine_key", "desktop_setups", ["org_id", "machine_key"])


def downgrade() -> None:
    op.drop_index("ix_desktop_setups_org_machine_key", table_name="desktop_setups")
    op.drop_column("desktop_setups", "revoked_reason")
    op.drop_column("desktop_setups", "machine_key")
