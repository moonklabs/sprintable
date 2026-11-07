"""E-MCP-HTTP S1: per-connection bearer auth — Streamable HTTP(외부/Poke) 전용 ASGI 미들웨어.

매 요청 경계서 ``Authorization: Bearer <key>`` 를 추출해 api_client 의 per-request 키 contextvar 에 set
(멀티테넌트·키마다 scope/백엔드 호출 분리). ``X-Project-Id`` 는 기존 project override 에 매핑. 키 없으면
401(MCP /mcp 경로 한정·health 류 비-MCP 경로는 통과해 S2 Cloud Run 헬스체크 호환). contextvar 는
요청 async-context 별 격리되며 finally 에서 reset(누수 0).
"""
from __future__ import annotations

import json
import logging

from .api_client import (
    INVALID_KEY_LINE,
    UNREACHABLE_LINE,
    InvalidApiKey,
    ServerUnreachable,
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


async def _send_json_error(send, status: int, code: str, message: str, extra_headers: list[tuple[bytes, bytes]]) -> None:
    body = json.dumps({"error": {"code": code, "message": message}}, ensure_ascii=False).encode("utf-8")
    await send({
        "type": "http.response.start",
        "status": status,
        "headers": [(b"content-type", b"application/json; charset=utf-8"), *extra_headers],
    })
    await send({"type": "http.response.body", "body": body})


async def _send_401_invalid_key(send) -> None:
    # story 4849 — the key was sent and the server does not know it: wrong, mistyped or revoked (one text for all). 401 on the FIRST request (initialize), so a client shows it before any tool
    # is listed: Claude Code prints «Server rejected the configured Authorization header (HTTP 401) … Error detail: {…message…}».
    await _send_json_error(send, 401, "invalid_api_key", INVALID_KEY_LINE, [(b"www-authenticate", b'Bearer error="invalid_token"')])


async def _send_503_unreachable(send) -> None:
    # story 4849 — the key could not be checked because the server behind this one could not be asked: not the key's fault, so not a 401 and not «make a new key».
    await _send_json_error(send, 503, "server_unreachable", UNREACHABLE_LINE, [(b"retry-after", b"5")])


_NO_STREAM_BODY = (
    b'{"error":{"code":"method_not_allowed",'
    b'"message":"This server does not open a server-to-client stream: POST to /mcp"}}'
)


async def _send_405_no_stream(send) -> None:
    # story 4804: the MCP spec lets a server that does not offer an SSE stream at the endpoint answer a GET with 405 (Streamable HTTP,
    # «Listening for Messages from the Server»). This server is stateless — every POST gets a fresh transport that is gone with the
    # response — and sends the client nothing of its own (no notification, no list-changed, no request), so the standalone stream
    # that the SDK opens for a GET could only ever carry its 15-second pings, while it keeps the connection (and a Cloud Run
    # instance) busy for as long as the client stays.
    await send({
        "type": "http.response.start",
        "status": 405,
        "headers": [
            (b"content-type", b"application/json"),
            (b"allow", b"POST"),
        ],
    })
    await send({"type": "http.response.body", "body": _NO_STREAM_BODY})


async def _send_health(send) -> None:
    # E-MCP-HTTP S2: Cloud Run HTTP liveness/readiness — streamable_http_app 엔 /health 라우트가 없어
    # 404 나므로 미들웨어가 직접 200(인증 불요). 의존성(백엔드) 미체크 = liveness 용(서버 살아있음).
    await send({
        "type": "http.response.start",
        "status": 200,
        "headers": [(b"content-type", b"application/json")],
    })
    await send({"type": "http.response.body", "body": b'{"status":"ok"}'})


def bearer_auth_asgi(app, get_stream: bool = False):
    """app(streamable_http_app) 을 per-request bearer auth 로 감싸는 순수 ASGI 미들웨어.

    ``get_stream=False``(기본, story 4804): ``GET /mcp`` 는 인증 이전에 405(``Allow: POST``) — SDK 의 무상태 모드가 GET 에 여는
    standalone SSE 스트림은 보낼 것이 없는 채 연결만 붙들어 둔다. ``True`` 는 SDK 동작(스트림 개방)으로의 되돌림 스위치
    (env ``MCP_HTTP_GET_STREAM``)."""

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
        # story 4804: no server-to-client stream (nothing to protect, so before the key and before the backend lookup below)
        if not get_stream and scope.get("method") == "GET":
            await _send_405_no_stream(send)
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
            except InvalidApiKey:
                # story 4849 — said without the key (not even its first characters) in the answer or in the log
                logger.warning("MCP connection refused: the API key is wrong or revoked")
                await _send_401_invalid_key(send)
                return
            except ServerUnreachable:
                logger.warning("MCP connection refused: the key could not be checked (server unreachable)")
                await _send_503_unreachable(send)
                return
            except Exception as exc:  # noqa: BLE001
                # the status only: the backend's text could echo what was sent (the key)
                logger.warning("ensure_auth_context 실패(non-fatal): %s", getattr(exc, "status", type(exc).__name__))
            await app(scope, receive, send)
        finally:
            reset_api_key_override(ktok)
            reset_project_override(ptok)

    return middleware
