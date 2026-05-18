"""python -m backend.mcp — Sprintable Python MCP server entry point."""

import asyncio
import sys

from .api_client import SprintableApiError, client
from .config import settings
from .server import mcp


def main() -> None:
    if not settings.sprintable_api_url:
        print("Error: SPRINTABLE_API_URL environment variable required", file=sys.stderr)
        sys.exit(1)
    if not settings.agent_api_key:
        print("Error: AGENT_API_KEY environment variable required", file=sys.stderr)
        sys.exit(1)

    client.configure(settings.sprintable_api_url, settings.agent_api_key)
    try:
        asyncio.run(client.resolve_auth_context())
    except SprintableApiError as exc:
        if exc.status == 401:
            print("Error: Invalid API Key — AGENT_API_KEY를 확인하는.", file=sys.stderr)
        else:
            print(f"Error: /auth/me {exc.status}: {exc}", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        print(f"Error: auth context resolve failed: {exc}", file=sys.stderr)
        sys.exit(1)

    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
