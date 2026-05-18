from mcp.server.fastmcp import FastMCP
from mcp.types import TextContent

from .config import settings
from .response import ok

mcp = FastMCP(
    name="sprintable-mcp-python",
    instructions=(
        "Sprintable Python MCP server. "
        f"Backend: {settings.sprintable_api_url}"
    ),
)


@mcp.tool()
def ping() -> list[TextContent]:
    """서버 생존 확인용 smoke tool."""
    return ok({"status": "pong"})
