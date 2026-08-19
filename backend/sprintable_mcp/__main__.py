"""python -m backend.mcp — Sprintable Python MCP server entry point."""

import asyncio
import contextlib
import sys

from .api_client import SprintableApiError, client
from .config import settings
from .server import filter_tools_by_scope, mcp, transport_security
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
        # story #2166(2026-07-25, 까심 QA): 이전엔 "required"만 찍고 값이 무엇인지·어디서
        # 얻는지 0였다 — OSS 사용자의 첫 명령이 안내 없이 죽는 첫인상 결함이었다. self-host
        # 예시(docker-compose 기본 backend 포트 8000)만 값으로 박는다 — prod URL을 여기
        # 하드코딩하면 self-host 사용자를 조용히 우리 백엔드로 연결시키는 더 나쁜 결함이 된다
        # (①을 기본값으로도 채택 안 한 이유와 동일 근거).
        print(
            "Error: SPRINTABLE_API_URL environment variable required "
            "(the base URL of your Sprintable backend).\n"
            "  Self-hosting (docker compose up)? Try: export SPRINTABLE_API_URL=http://localhost:8000\n"
            "  Using a hosted Sprintable instance? See https://pypi.org/project/sprintable/ for the URL to use.",
            file=sys.stderr,
        )
        sys.exit(1)

    # E-MCP-HTTP S1: transport 분기. http=외부/Poke(per-request bearer·startup env-key auth/filter 없음·
    # SSE bridge 미구동=내부 이벤트 분리). stdio=내부 에이전트(현행·env 단일키·툴+이벤트). 기본 stdio(무회귀).
    transport = (settings.mcp_transport or "stdio").strip().lower()
    if transport == "http":
        _run_http()
        return

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


def _run_http() -> None:
    """E-MCP-HTTP S1: Streamable HTTP(외부/Poke) — 툴 전용. per-request bearer auth(http_auth ASGI
    미들웨어가 요청별 키 contextvar set)·startup env-key auth/filter 없음(scope 는 per-key·call-time).
    ⭐SSE bridge 미구동 = 내부 에이전트 실시간 이벤트는 stdio 경로 분리 유지(§7·격하 0)."""
    import uvicorn

    from .http_auth import bearer_auth_asgi

    # env fallback 키. ⭐http 모드 실제 인증은 per-request bearer override(미들웨어)라 이 fallback 은
    # never-hit(미들웨어가 bearer 없으면 401). agent_api_key 미설정 시 placeholder(configure 계약 유지·
    # 백엔드는 override 키로 호출되며 placeholder 가 새면 401 로 거름·fail-safe).
    client.configure(
        settings.sprintable_api_url,
        settings.agent_api_key or "_http_per_request_bearer_only_",
    )
    # E-MCP-HTTP S2: Cloud Run 은 $PORT 를 주입(8080 우연일치 의존 X) → PORT 우선·없으면 config default.
    import os

    port = int(os.environ.get("PORT") or settings.mcp_http_port)
    # story #2772(mcp 2.0 이관) — stateless_http(요청간 세션 미보존)·transport_security(DNS-rebinding
    # 보호)가 1.x에서는 MCPServer 생성자 인자였으나 2.0.0에서 streamable_http_app()로 이동(스파이크
    # 2026-08-19 실측, server.py:1218-1228 시그니처). stdio 모드는 이 호출 자체를 안 타서 무관(무회귀).
    app = bearer_auth_asgi(
        mcp.streamable_http_app(stateless_http=True, transport_security=transport_security)
    )
    print(
        f"Sprintable MCP — Streamable HTTP on {settings.mcp_http_host}:{port}/mcp "
        "(per-request bearer auth·tools-only)",
        file=sys.stderr,
    )
    uvicorn.run(app, host=settings.mcp_http_host, port=port, log_level="info")


if __name__ == "__main__":
    main()
