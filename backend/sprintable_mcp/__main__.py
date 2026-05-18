"""python -m backend.mcp — Sprintable Python MCP server entry point."""

import asyncio
import contextlib
import sys
import types as _types

from .api_client import SprintableApiError, client
from .config import settings
from .server import mcp
from .sse_bridge import register_session, start_sse_bridge


def _patch_session_capture() -> None:
    """lowlevel _handle_message를 패치해서 ServerSession을 register_session에 주입.

    MCP 클라이언트가 첫 메시지(initialize)를 보내면 세션이 캡처됨.
    이후 SSE 이벤트 → _send_mcp_notification에서 session.send_log_message 사용 가능.
    """
    orig = mcp._mcp_server._handle_message.__func__  # type: ignore[attr-defined]

    async def _capturing(self, message, session, lifespan_ctx, raise_exc=False):
        register_session(session)
        return await orig(self, message, session, lifespan_ctx, raise_exc)

    mcp._mcp_server._handle_message = _types.MethodType(_capturing, mcp._mcp_server)


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

    _patch_session_capture()
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
