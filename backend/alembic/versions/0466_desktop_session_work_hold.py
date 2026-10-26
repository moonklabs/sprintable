"""[SID:f320c093] (4779 AC3 · PO 10-25) — the web and the phone say WHY work is not reaching an agent whose computer cannot confirm (or has lost) the link to Sprintable's tools.

10-25 05:01Z: a lane stood 50 minutes with work waiting and nothing on any screen said so. The daemon already knows (its board shows «기다리는 일 n개 — …» + [다시 시작] /
[다시 연결]); it now says so in the report: desktop_sessions gets one nullable column, set by the report that carries `work_hold` (a report without it clears it — the
hold is gone, like `first_screen` / `inbox` / `run`):

- work_hold_why  TEXT — why work waits for this agent, as one closed word: `tools_unconfirmed` (the app could not confirm the agent's Sprintable tools for minutes) ·
                        `tools_failed` (the tools link is down after the app asked again). NULL = none (or not said). One word: no path, no account, no text.

Additive only: no backfill, no index. The closed set is held in the DB too (the API check alone is not the last word).
"""
import sqlalchemy as sa

from alembic import op

revision = "0466"
down_revision = "0465"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("desktop_sessions", sa.Column("work_hold_why", sa.Text(), nullable=True))
    op.create_check_constraint(
        "ck_desktop_sessions_work_hold_why", "desktop_sessions",
        "work_hold_why IS NULL OR work_hold_why IN ('tools_unconfirmed','tools_failed')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_desktop_sessions_work_hold_why", "desktop_sessions", type_="check")
    op.drop_column("desktop_sessions", "work_hold_why")
