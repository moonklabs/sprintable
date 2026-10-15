"""story #4540 (E-DESKTOP-2 C-5) — the model and effort a desktop agent starts with (contract 20764ba3 v1.1 §1).

- agent_run_profiles: one row per agent at most (no row = the runtime's defaults). The runtime itself stays in
  members.runtime_type. `version` goes up on every change so the daemon can tell the settings it runs with from the saved ones.
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0435"
down_revision = "0434"
branch_labels = None
depends_on = None

_UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.create_table(
        "agent_run_profiles",
        sa.Column("member_id", _UUID, sa.ForeignKey("members.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("model", sa.Text(), nullable=True),
        sa.Column("effort", sa.Text(), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("updated_by", _UUID, nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("agent_run_profiles")
