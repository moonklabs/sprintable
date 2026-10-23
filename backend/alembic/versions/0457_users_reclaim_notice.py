"""[SID:4725] decision 2 — «show it once»: the person whose unproved account was reclaimed is told, once, what was cut.

When a mailbox is PROVED for an account nobody had proved (`_reclaim_unproved_account`), what that account held and made before the proof is dropped.
The person had no way to learn it. One nullable JSONB on `users` is the server's «show this once» mark: the reclaim writes, in its own transaction, WHAT it actually
cut — {"cut": ["sessions", "providers", "two_step", "keys", "phones", "computers"] (only the ones that really existed), "password_cleared": bool} — and nothing
else (no token, no address, no id); `GET /auth/me` answers it as `reclaim_notice` and the person's own dismissal sets it back to NULL. It is on the account, not in a
cookie or an address, so every road in (the web's cookie session, the apps' hand-over code, a reset link) shows the same notice.

Additive only: no backfill (NULL = nothing to show), no index (read by primary key).
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0457"
down_revision = "0456"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("reclaim_notice", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "reclaim_notice")
