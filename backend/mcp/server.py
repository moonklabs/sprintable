from mcp.server.fastmcp import FastMCP

from .config import settings

mcp = FastMCP(
    name="sprintable-mcp-python",
    instructions=(
        "Sprintable Python MCP server. "
        f"Backend: {settings.sprintable_api_url}"
    ),
)


@mcp.tool()
def ping() -> str:
    """서버 생존 확인용 smoke tool."""
    return "pong"
