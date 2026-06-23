"""E-MCP-HTTP S1: per-connection bearer auth — Streamable HTTP(외부/Poke) 전용 ASGI 미들웨어.

매 요청 경계서 ``Authorization: Bearer <key>`` 를 추출해 api_client 의 per-request 키 contextvar 에 set
(멀티테넌트·키마다 scope/백엔드 호출 분리). ``X-Project-Id`` 는 기존 project override 에 매핑. 키 없으면
401(MCP /mcp 경로 한정·health 류 비-MCP 경로는 통과해 S2 Cloud Run 헬스체크 호환). contextvar 는
요청 async-context 별 격리되며 finally 에서 reset(누수 0).
"""
from __future__ import annotations

import logging

from .api_client import (
    client,
    reset_api_key_override,
    reset_project_override,
    set_api_key_override,
    set_project_override,
)

logger = logging.getLogger(__name__)

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


async def _send_health(send) -> None:
    # E-MCP-HTTP S2: Cloud Run HTTP liveness/readiness — streamable_http_app 엔 /health 라우트가 없어
    # 404 나므로 미들웨어가 직접 200(인증 불요). 의존성(백엔드) 미체크 = liveness 용(서버 살아있음).
    await send({
        "type": "http.response.start",
        "status": 200,
        "headers": [(b"content-type", b"application/json")],
    })
    await send({"type": "http.response.body", "body": b'{"status":"ok"}'})


def bearer_auth_asgi(app):
    """app(streamable_http_app) 을 per-request bearer auth 로 감싸는 순수 ASGI 미들웨어."""

    async def middleware(scope, receive, send):
        if scope.get("type") != "http":
            await app(scope, receive, send)
            return
        path = scope.get("path", "")
        # S2: Cloud Run HTTP health(/health·/healthz) → 200 직응답(streamable_http_app 404 방지·인증 불요).
        if path in ("/health", "/healthz"):
            await _send_health(send)
            return
        # 비-MCP 경로는 인증 없이 app 으로 통과(향후 다른 라우트 호환).
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
            # ee2f4e58: 이 키의 default 컨텍스트(member/org/project)를 1회 해소·캐시 →
            # 명시 project_id 없는 툴 호출도 키 default 로 해소(stdio parity·422 제거).
            # additive·non-fatal: 해소 실패해도 인증 흐름은 진행(백엔드가 401/422 로 자연 처리).
            try:
                await client.ensure_auth_context(key)
            except Exception as exc:  # noqa: BLE001
                logger.warning("ensure_auth_context 실패(non-fatal): %s", exc)
            await app(scope, receive, send)
        finally:
            reset_api_key_override(ktok)
            reset_project_override(ptok)

    return middleware
