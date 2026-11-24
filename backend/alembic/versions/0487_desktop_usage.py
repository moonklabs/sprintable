"""story 4981 (연결 ③) — the computer's last known agent usage: `desktop_usage`.

One row per (computer, CLI, account): the percentage of each limit window used and when it resets, as the computer's host read them (Claude Code's status line · Codex's rate limits) — CLOSED numbers
only (whole percent 0..100 · window length · reset time), or the word `unavailable` with its reason (`api_key` · `not_read`). `seen_at` = when the HOST last saw the numbers (the phone says «마지막으로 본 지 N분 전»
from it); `reported_at` = when the server took them. A report is the computer's own word, written through `PUT /api/v2/desktop/relay/usage` by the device token of THAT computer only. Rows go with the computer
(ON DELETE CASCADE). Additive: a new table, nothing backfilled.
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0487"
down_revision = "0486"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "desktop_usage",
        sa.Column("setup_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("desktop_setups.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("runtime", sa.Text(), primary_key=True),
        # the CLI's settings folder on that computer as an OPAQUE short id the host makes (never a path): two logins of one CLI on one computer are two rows, never one covering the other (Kadir 863 low ⓐ)
        sa.Column("account", sa.Text(), primary_key=True),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("why", sa.Text(), nullable=True),
        sa.Column("windows", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reported_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("runtime IN ('claude', 'codex')", name="ck_desktop_usage_runtime"),
        sa.CheckConstraint("account ~ '^[a-z0-9]{8,32}$'", name="ck_desktop_usage_account"),
        sa.CheckConstraint("state IN ('windows', 'unavailable')", name="ck_desktop_usage_state"),
        sa.CheckConstraint("why IS NULL OR why IN ('api_key', 'not_read')", name="ck_desktop_usage_why"),
        # the two shapes are the only ones: numbers (no reason) or the word (a reason · no numbers)
        sa.CheckConstraint(
            "(state = 'windows' AND why IS NULL AND jsonb_typeof(windows) = 'array' AND jsonb_array_length(windows) BETWEEN 1 AND 4)"
            " OR (state = 'unavailable' AND why IS NOT NULL AND windows = '[]'::jsonb)",
            name="ck_desktop_usage_shape",
        ),
    )


def downgrade() -> None:
    op.drop_table("desktop_usage")
