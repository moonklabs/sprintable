"""story #4546 (E-2선 · 보안 관측) — the agent key usage ledger says where a call came from.

Until now each row had only the path, the method and `request.client.host` — on Cloud Run always the front end's own address
(169.254.x.x), so a call from a person's Mac and one from the hosted MCP server looked the same, and whether a call came through
MCP was not recorded per row. The writer now records the real client address (the one shared rule, app/core/client_ip.py) and:

- agent_api_key_usage_logs.mcp_transport: TEXT, NULL — the MCP client's own `X-MCP-Transport` (stdio · http); NULL = a direct
  call (not through our MCP client) or a row from before this.
- agent_api_key_usage_logs.tool_name: TEXT, NULL — the MCP tool the call was made for (`X-Sprintable-Tool`); NULL outside a tool call.
Both are the client's own words — for looking, never for deciding (nothing authorises on them). No row changes on upgrade.
Downgrade drops both.
"""
import sqlalchemy as sa

from alembic import op

revision = "0447"
down_revision = "0446"  # 4629's (remote_devices.session_token_id)
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("agent_api_key_usage_logs", sa.Column("mcp_transport", sa.Text(), nullable=True))
    op.add_column("agent_api_key_usage_logs", sa.Column("tool_name", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("agent_api_key_usage_logs", "tool_name")
    op.drop_column("agent_api_key_usage_logs", "mcp_transport")
