"""[SID:4752] account deletion that really closes the account: `users.deleted_at` (when the person pressed [계정 삭제]) and `users.anonymized_at` (when the purge job removed the personal data).

- deleted_at NULL = a live account. Set = deleted: the account cannot sign in, refresh or be found by email / provider id (the code side filters on `is_active`, which the deletion
  now sets false together with this stamp — the stamp is what the 30-day purge counts from, and a person with no organization has no other row that carries a time).
- anonymized_at NULL = the personal data is still there. Set once the purge ran (the account row keeps its id: what the person wrote stays, pointing at an id with no name).

Additive only: no backfill (an account deleted before this migration keeps `is_active` as it was; nothing to count a grace period from).
"""
import sqlalchemy as sa

from alembic import op

revision = "0460"
down_revision = "0459"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("users", sa.Column("anonymized_at", sa.DateTime(timezone=True), nullable=True))
    # No index: the purge job reads «deleted_at IS NOT NULL AND anonymized_at IS NULL» once a day (one scan of `users`), and a plain CREATE INDEX would block writes on a big table while a
    # CONCURRENTLY one cannot run in this project's migrations (alembic/env.py) — if `users` ever grows past what a daily scan can bear, add the index by hand after a deploy.


def downgrade() -> None:
    op.drop_column("users", "anonymized_at")
    op.drop_column("users", "deleted_at")
