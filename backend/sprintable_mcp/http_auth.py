"""E-MCP-HTTP S1: per-connection bearer auth — Streamable HTTP(외부/Poke) 전용 ASGI 미들웨어.

매 요청 경계서 ``Authorization: Bearer <key>`` 를 추출해 api_client 의 per-request 키 contextvar 에 set
(멀티테넌트·키마다 scope/백엔드 호출 분리). ``X-Project-Id`` 는 기존 project override 에 매핑. 키 없으면
401(MCP /mcp 경로 한정·health 류 비-MCP 경로는 통과해 S2 Cloud Run 헬스체크 호환). contextvar 는
요청 async-context 별 격리되며 finally 에서 reset(누수 0).
"""
from __future__ import annotations

from .api_client import (
    reset_api_key_override,
    reset_project_override,
    set_api_key_override,
    set_project_override,
)

_UNAUTHORIZED_BODY = (
    b'{"error":{"code":"unauthorized",'
    b'"message":"Authorization: Bearer <api_key> required"}}'
)


async def _send_401(send) -> None:
    await send({
        "type": "http.response.start",
        "status": 401,
        "headers": [
            (b"content-type", b"application/json"),
            (b"www-authenticate", b"Bearer"),
        ],
    })
    await send({"type": "http.response.body", "body": _UNAUTHORIZED_BODY})


def bearer_auth_asgi(app):
    """app(streamable_http_app) 을 per-request bearer auth 로 감싸는 순수 ASGI 미들웨어."""

    async def middleware(scope, receive, send):
        if scope.get("type") != "http":
            await app(scope, receive, send)
            return
        path = scope.get("path", "")
        # 비-MCP 경로(health 등)는 인증 없이 통과 — S2 Cloud Run liveness/readiness 호환.
        if not path.startswith("/mcp"):
            await app(scope, receive, send)
            return

        headers = {k.decode("latin-1").lower(): v.decode("latin-1")
                   for k, v in scope.get("headers", [])}
        auth = headers.get("authorization", "")
        if not auth[:7].lower() == "bearer " or not auth[7:].strip():
            await _send_401(send)
            return

        key = auth[7:].strip()
        project_id = headers.get("x-project-id") or None
        ktok = set_api_key_override(key)
        ptok = set_project_override(project_id)
        try:
            await app(scope, receive, send)
        finally:
            reset_api_key_override(ktok)
            reset_project_override(ptok)

    return middleware
