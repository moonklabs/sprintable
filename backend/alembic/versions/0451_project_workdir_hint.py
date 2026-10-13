"""[SID:4681] (UX-1 · D3 · AC4) — a project remembers the folder a person picked for it, as text.

- projects gets one nullable column: `workdir_hint` (TEXT) — the folder's name as the person gave it on their computer, shown
  to people and other devices as a hint. The server never opens or resolves it as a path; the folder an agent starts in is
  decided on the Mac from its own mapping (desktop-electron project-workdirs · the 4565 home-only check).
- Additive only: no backfill, no existing row changes, no index (never queried by value).
"""
import sqlalchemy as sa

from alembic import op

revision = "0451"
down_revision = "0450"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("workdir_hint", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("projects", "workdir_hint")
