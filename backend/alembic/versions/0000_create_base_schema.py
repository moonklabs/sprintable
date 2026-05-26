"""OSS base schema — chain root for incremental migrations.

Revision ID: 0000
Revises: (none — chain root)
Create Date: 2026-05-26

Fresh OSS installs are handled in env.py: create_all(checkfirst=False) + stamp("head")
bypasses the incremental chain when no application tables exist yet.

For existing SaaS/Cloud SQL DBs this revision is already stamped, so upgrade
simply continues from the current version.
"""
from __future__ import annotations

revision = "0000"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Fresh DB bootstrap is handled in alembic/env.py (create_all + stamp head).
    # This revision is the chain root; its body is intentionally empty.
    pass


def downgrade() -> None:
    pass
