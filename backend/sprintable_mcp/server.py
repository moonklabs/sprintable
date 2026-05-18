from mcp.server.fastmcp import FastMCP
from mcp.types import TextContent

from .config import settings
from .response import ok
from .tools.stories import ListStoriesInput, list_stories

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


@mcp.tool()
async def sprintable_list_stories(args: ListStoriesInput) -> list[TextContent]:
    """프로젝트 스토리 목록 조회. project_id/org_id는 context에서 자동 주입."""
    return await list_stories(args)
