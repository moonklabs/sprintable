"""[SID:4791] SSE lease rows — the one-receiver-per-agent contract without Redis.

The desktop relay's «one receiver, take-over» contract lives in the SSE lease. With Redis off (dev after the Redis shutdown, a self-hosted default)
and two backend instances, the lease was each instance's own memory: receiver A on instance 1 and receiver B on instance 2 both stayed alive and both
read the same command. These two tables hold the lease for the `perkey:<agent>` scopes (`services/sse_lease_pg.py`) — same shape as the Redis ZSET and
its take-over mark.

Additive only: two new tables, nothing is altered, nothing is backfilled (a lease is born with its stream and lapses by itself).
"""
import sqlalchemy as sa

from alembic import op

revision = "0469"
down_revision = "0468"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sse_leases",
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column("member", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("scope", "member"),
    )
    op.create_index("ix_sse_leases_expires_at", "sse_leases", ["expires_at"])
    op.create_table(
        "sse_lease_taken",
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column("member", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("scope"),
    )


def downgrade() -> None:
    op.drop_table("sse_lease_taken")
    op.drop_index("ix_sse_leases_expires_at", table_name="sse_leases")
    op.drop_table("sse_leases")
