"""story #4641 (design 4641 · Kadir lens conditional pass · PO) — a permission widening a person made at the terminal, on the session.

- desktop_sessions gets three nullable columns: `permission_widened_at` (the daemon's clock), `permission_widened_from` and
  `permission_widened_to` — the mode before and after, each from a closed list (plan · default · acceptEdits · auto ·
  bypassPermissions). Not a session state word: the state list stays as it is.
- The three are all set or all null (one CHECK). The server checks the closed lists and from ≠ to only; the order is the daemon's.
- Additive only: no backfill, no existing row changes.
"""
import sqlalchemy as sa

from alembic import op

revision = "0449"
down_revision = "0448"
branch_labels = None
depends_on = None

_MODES = ("plan", "default", "acceptEdits", "auto", "bypassPermissions")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def upgrade() -> None:
    op.add_column("desktop_sessions", sa.Column("permission_widened_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("desktop_sessions", sa.Column("permission_widened_from", sa.Text(), nullable=True))
    op.add_column("desktop_sessions", sa.Column("permission_widened_to", sa.Text(), nullable=True))
    op.create_check_constraint(
        "ck_desktop_sessions_widened_from", "desktop_sessions", f"permission_widened_from IS NULL OR {_in('permission_widened_from', _MODES)}",
    )
    op.create_check_constraint(
        "ck_desktop_sessions_widened_to", "desktop_sessions", f"permission_widened_to IS NULL OR {_in('permission_widened_to', _MODES)}",
    )
    op.create_check_constraint(
        "ck_desktop_sessions_widened_all_or_none", "desktop_sessions",
        "(permission_widened_at IS NULL) = (permission_widened_from IS NULL) AND (permission_widened_from IS NULL) = (permission_widened_to IS NULL)",
    )


def downgrade() -> None:
    op.drop_constraint("ck_desktop_sessions_widened_all_or_none", "desktop_sessions", type_="check")
    op.drop_constraint("ck_desktop_sessions_widened_to", "desktop_sessions", type_="check")
    op.drop_constraint("ck_desktop_sessions_widened_from", "desktop_sessions", type_="check")
    op.drop_column("desktop_sessions", "permission_widened_to")
    op.drop_column("desktop_sessions", "permission_widened_from")
    op.drop_column("desktop_sessions", "permission_widened_at")
