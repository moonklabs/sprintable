"""[SID:4714] (design 4714-design.md · contract 02d2cf71) — what a computer says it can start for a phone.

A phone picks a Mac, an agent and a project, and signs «start this agent for that project here». The folder is the Mac's own (it reads
its own files and checks them again at the start) — the server only needs to know which (agent, project) pairs the computer has a usable
folder for, so the phone is not offered a start the computer would refuse. desktop_setups gets one nullable column, replaced whole by
the computer's own `PUT /relay/startable`:

- startable  JSONB — a list of {agent_member_id, project_id} (ids only — never a path). NULL = the computer has said nothing (an app from
                     before this); the phone then offers no start for it and says «start it at the Mac».

Additive only: no backfill, no index.
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0455"
down_revision = "0454"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("desktop_setups", sa.Column("startable", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("desktop_setups", "startable")
