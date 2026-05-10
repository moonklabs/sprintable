"""add totp security fields (replay prevention + lockout)

Revision ID: 0017
Revises: 0016
Create Date: 2026-05-10
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    for col, col_type, default in [
        ("totp_last_timestep", sa.Integer, None),
        ("totp_fail_count", sa.Integer, "0"),
        ("totp_locked_until", sa.DateTime(timezone=True), None),
    ]:
        exists = conn.execute(
            sa.text(
                "SELECT EXISTS (SELECT 1 FROM information_schema.columns "
                "WHERE table_name='users' AND column_name=:col)"
            ),
            {"col": col},
        ).scalar()
        if not exists:
            kwargs = {"nullable": True}
            if default is not None:
                kwargs["server_default"] = default
                kwargs["nullable"] = False
            op.add_column("users", sa.Column(col, col_type, **kwargs))


def downgrade() -> None:
    for col in ("totp_locked_until", "totp_fail_count", "totp_last_timestep"):
        op.drop_column("users", col)
