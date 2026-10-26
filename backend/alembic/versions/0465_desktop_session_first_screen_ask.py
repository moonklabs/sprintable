"""[SID:4763] (AC4 · PO 10-24) — the web and the phone say «Mac에서 답을 기다려요» while a session's first-screen question stands.

A session that stands on Claude Code's folder-trust question reports `starting` for as long as the question stands (it has not begun to run), so the
conversation's strip said «시작됨» for minutes while the question waited at that computer (measured 5 min 22 s, 4757). The daemon reads the question already;
it now says so in the report: desktop_sessions gets one nullable column, set by the report that carries `first_screen` (a report without it clears it — the
question is gone, like `run` / `inbox` / `instruct_now`):

- first_screen_ask  TEXT — the first-screen question that stands at that computer, as one closed word — the daemon's own list (4528): `trust` (folder trust) · `mcp` / `mcp_many`
                           (Claude's «new MCP server(s) found») · `update` (Codex's update question). NULL = none (or not said). One word: no
                           folder, no path, no text of the question ever leaves the computer.

Additive only: no backfill, no index. The closed set is held in the DB too (the API check alone is not the last word).
"""
import sqlalchemy as sa

from alembic import op

revision = "0465"
down_revision = "0464"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("desktop_sessions", sa.Column("first_screen_ask", sa.Text(), nullable=True))
    op.create_check_constraint(
        "ck_desktop_sessions_first_screen_ask", "desktop_sessions",
        "first_screen_ask IS NULL OR first_screen_ask IN ('trust','mcp','mcp_many','update')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_desktop_sessions_first_screen_ask", "desktop_sessions", type_="check")
    op.drop_column("desktop_sessions", "first_screen_ask")
