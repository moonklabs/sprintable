"""[SID:4826] embedded_timer_runs — when each in-app timer job last ran.

The app's own server runs the scheduled jobs a hosted deployment gets from the cloud scheduler (`services/embedded_timers.py`). A job whose interval passed while
the app was closed runs once right after start; this table is where a restart reads the last time from.

Additive only: one new table, nothing is altered, nothing is backfilled (a row is born with the job's first run).
"""
import sqlalchemy as sa

from alembic import op

revision = "0470"
down_revision = "0469"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "embedded_timer_runs",
        sa.Column("job_name", sa.Text(), nullable=False),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_status", sa.Integer(), nullable=True),
        sa.Column("last_ms", sa.Integer(), nullable=True),
        sa.PrimaryKeyConstraint("job_name"),
    )


def downgrade() -> None:
    op.drop_table("embedded_timer_runs")
