"""python -m backend.mcp — Sprintable Python MCP server entry point."""

import sys

from .config import settings
from .server import mcp


def main() -> None:
    if not settings.agent_api_key:
        print("Error: AGENT_API_KEY environment variable required", file=sys.stderr)
        sys.exit(1)

    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
