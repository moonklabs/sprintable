"""python -m backend.mcp — Sprintable Python MCP server entry point."""

import asyncio
import contextlib
import sys

from .api_client import SprintableApiError, client
from .config import settings
from .server import filter_tools_by_scope, mcp
from .sse_bridge import start_sse_bridge


async def _setup() -> list[str] | None:
    """auth context resolve + E-MCP S3 toolset 매니페스트 scope 조회.

    auth 실패는 raise(상위에서 exit). 매니페스트 실패는 None 반환(레거시 비파괴셋으로 degrade, crash X).
    """
    await client.resolve_auth_context()
    try:
        manifest = await client.get("/api/v2/mcp/manifest")
        return manifest.get("scope")
    except Exception as exc:  # noqa: BLE001
        print(f"Warning: MCP manifest fetch 실패 ({exc}) — 레거시 비파괴셋으로 degrade", file=sys.stderr)
        return None


def main() -> None:
    if not settings.sprintable_api_url:
        print("Error: SPRINTABLE_API_URL environment variable required", file=sys.stderr)
        sys.exit(1)
    if not settings.agent_api_key:
        print("Error: AGENT_API_KEY environment variable required", file=sys.stderr)
        sys.exit(1)

    client.configure(settings.sprintable_api_url, settings.agent_api_key)
    try:
        _scope = asyncio.run(_setup())
    except SprintableApiError as exc:
        if exc.status == 401:
            print("Error: Invalid API Key — AGENT_API_KEY를 확인하는.", file=sys.stderr)
        else:
            print(f"Error: /auth/me {exc.status}: {exc}", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        print(f"Error: auth context resolve failed: {exc}", file=sys.stderr)
        sys.exit(1)

    # E-MCP S3: 허용 toolset만 노출 (S2 wrapper의 call-time 차단은 유지·defense-in-depth)
    n_hidden = filter_tools_by_scope(_scope)
    if n_hidden:
        print(f"MCP toolset: {n_hidden} tools hidden by key scope", file=sys.stderr)

    asyncio.run(_run())


async def _run() -> None:
    """MCP stdio 서버 + SSE 브릿지를 동일 이벤트 루프에서 실행."""
    sse_task = asyncio.create_task(
        start_sse_bridge(
            settings.sprintable_api_url,
            settings.agent_api_key,
            client.member_id,
        )
    )
    try:
        await mcp.run_stdio_async()
    finally:
        sse_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await sse_task


if __name__ == "__main__":
    main()
