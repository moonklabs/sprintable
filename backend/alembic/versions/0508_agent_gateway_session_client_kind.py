"""[SID:5046 C13] `agent_gateway_sessions.client_kind` — what the client said it is when it opened its stream (`host` or NULL).

The web's «지금 끼어들기 / 끝나고 이어서» choice is for working agents a HOST runs; a webhook or the channel plugin reads `delivery_mode` nowhere, so the choice there would be a promise nothing keeps. The desktop
host says `X-Sprintable-Client: host` when it opens `/agent/stream`; the session row keeps it; the room's `/working` list answers `host_run` per agent from it.

The column is the client's OWN word (not a login): it is read to decide what the web DRAWS, never a permission or a delivery road (pinned by a census test). Nullable, no default, no backfill: every existing row — and
every old host that sends no word — is NULL = not a host = no choice drawn = today's behaviour. One metadata-only ALTER (a nullable column with no default takes no table rewrite).

Revision ID: 0508
Revises: 0507
Create Date: 2026-11-28
"""
from alembic import op

revision = "0508"
down_revision = "0507"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE agent_gateway_sessions ADD COLUMN IF NOT EXISTS client_kind varchar(16) NULL")


def downgrade() -> None:
    op.execute("ALTER TABLE agent_gateway_sessions DROP COLUMN IF EXISTS client_kind")
