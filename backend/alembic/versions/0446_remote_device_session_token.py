"""story #4629 (2선 · 4624 후속 · PO 09:02Z: A2) — [이 폰 빼기] also ends that phone's own login session.

A phone registers its key while logged in on it; until now nothing tied the key to that login, so removing a lost phone's key
left its session alive (the account open on it · and the same key could come back). The phone's registration now records
which refresh token it was logged in with — the row id only (the raw token is found by its hash and never kept) — and
removing the key follows that token's rotation chain (`replaced_by`) to the live one and revokes it. No other session of the
person is touched.

- remote_devices.session_token_id: UUID, NULL (keys registered before this, or a registration that sent no token) · FK
  refresh_tokens.id ON DELETE SET NULL (a pruned token leaves the key «session not found», never a broken row).
No row changes on upgrade. Downgrade drops the column.
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0446"
down_revision = "0445"  # 4590's (terminal_only)
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("remote_devices", sa.Column("session_token_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(
        "fk_remote_devices_session_token_id", "remote_devices", "refresh_tokens",
        ["session_token_id"], ["id"], ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_remote_devices_session_token_id", "remote_devices", type_="foreignkey")
    op.drop_column("remote_devices", "session_token_id")
