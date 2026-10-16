"""story #4560 (E-DESKTOP-2 · contract v2.1 §5 · PO 2026-10-07 14:41Z · Yuna `4560-limit-resume-copy.md` §③) — the daemon held off at
a usage limit's end.

When the time a limit was to lift has come, the daemon clears Claude's limit only when the terminal shows exactly what it expects
(the limit's own choice window, or an empty input line); otherwise it presses nothing and says so. The phone and the web show
«… 그 컴퓨터의 터미널에서 확인해 주세요» with no button.

- desktop_sessions.limit_held: `screen` (the screen was not the expected one) · `esc_not_taken` (the one Esc it sent was not taken).
  Nullable — a row without a hold has none. Carried with a limit only (the service refuses a limit on any other word), and cleared by
  any report without one, like the other limit columns.
No row changes.
"""
import sqlalchemy as sa

from alembic import op

revision = "0444"
down_revision = "0443"  # 4599's (Didi · end_session) — 0441 is #4980 (4598) · 0442/0443 are 4599's
branch_labels = None
depends_on = None

_HELD = ("screen", "esc_not_taken")


def upgrade() -> None:
    op.add_column("desktop_sessions", sa.Column("limit_held", sa.Text(), nullable=True))
    op.create_check_constraint(
        "ck_desktop_sessions_limit_held", "desktop_sessions",
        f"limit_held IS NULL OR limit_held IN ({', '.join(repr(v) for v in _HELD)})",
    )


def downgrade() -> None:
    op.drop_constraint("ck_desktop_sessions_limit_held", "desktop_sessions", type_="check")
    op.drop_column("desktop_sessions", "limit_held")
