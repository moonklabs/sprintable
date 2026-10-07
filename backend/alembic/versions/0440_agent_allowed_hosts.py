"""story #4580 (E-DESKTOP-2 · AC2) — a desktop agent's «허용 주소» list (the hosts it may connect to without asking).

- agent_allowed_hosts: one row per (agent, host) · exact lower-case hosts only (checked in the service) · added after a person's
  signed answer (story #4580 B), removed by whoever may change the agent's run profile.
- agent_permission_requests.stage (ask · confirm) + host: a network question answered «allow…» comes back for a second answer
  with the host the daemon read from Claude's own hook text (Kadir ⓐ · the host is the row's, never taken anew).
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0440"
down_revision = "0439"
branch_labels = None
depends_on = None

_UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.create_table(
        "agent_allowed_hosts",
        sa.Column("member_id", _UUID, sa.ForeignKey("members.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("host", sa.Text(), primary_key=True),
        sa.Column("added_by", _UUID, nullable=True),
        sa.Column("request_id", _UUID, nullable=True),
        sa.Column("added_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.add_column("agent_permission_requests", sa.Column("stage", sa.Text(), nullable=False, server_default="ask"))
    op.add_column("agent_permission_requests", sa.Column("host", sa.Text(), nullable=True))
    op.create_check_constraint("ck_agent_permission_requests_stage", "agent_permission_requests", "stage IN ('ask', 'confirm')")


def downgrade() -> None:
    op.drop_constraint("ck_agent_permission_requests_stage", "agent_permission_requests", type_="check")
    op.drop_column("agent_permission_requests", "host")
    op.drop_column("agent_permission_requests", "stage")
    op.drop_table("agent_allowed_hosts")
