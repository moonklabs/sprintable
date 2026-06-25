"""에이전트 온보딩 config 단일 SSOT generator (OB-1 · 블루프린트 §2/§7).

team_members·agents 라우트 + connection-artifact API 가 **모두 이 generator 하나만** 소비한다 —
README·onboarding-form·in-app docs·로컬 buildMcpConfig 4갈래로 흩어져 모순되던 config 를 단일화.

생성 아티팩트 = **stdio sprintable-mcp `.mcp.json`**(§2): stdio 만 툴+이벤트를 한 프로세스로 묶는다
(HTTP=tools-only). ``SPRINTABLE_AGENT_ID``/``WS_URL``/``port`` 는 넣지 않는다(서버 자동 도출/불요).
``SPRINTABLE_API_URL`` 은 **backend-direct Cloud Run URL** — CF-fronted 깔끔 도메인은 ①/agent/stream
SSE 버퍼링 ②봇차단 때문에 금지(블루프린트 §2/§3·선생님 catch).
"""
from __future__ import annotations

import os

DEFAULT_RUNTIME = "claude-code"
SUPPORTED_RUNTIMES = frozenset({"claude-code"})

_LOCAL_FALLBACK_URL = "http://localhost:8000"
# generator 가 backend-direct URL 을 읽는 런타임 env 후보(우선순위). 배포가 주입.
# `_FASTAPI_URL`(cloudbuild)·`NEXT_PUBLIC_FASTAPI_URL`(FE)·`fastapi_url`(gh action) 컨벤션과 일치.
_BACKEND_URL_ENV_KEYS = ("FASTAPI_URL", "SPRINTABLE_API_URL")


def resolve_backend_direct_url() -> str:
    """에이전트가 호출할 backend-direct Cloud Run URL.

    배포가 주입한 env(``FASTAPI_URL`` 우선) → 미설정(로컬)이면 localhost fallback. trailing slash 제거.
    **CF-fronted 깔끔 도메인 금지** — /agent/stream SSE 도달이 필수라 직통 run.app 이어야 한다.
    """
    for key in _BACKEND_URL_ENV_KEYS:
        val = os.environ.get(key, "").strip()
        if val:
            return val.rstrip("/")
    return _LOCAL_FALLBACK_URL


def build_agent_mcp_config(
    *,
    api_key_plaintext: str | None,
    runtime: str = DEFAULT_RUNTIME,
) -> dict:
    """stdio sprintable-mcp `.mcp.json` 아티팩트(SSOT · 블루프린트 §2).

    env = {``SPRINTABLE_API_URL`` = backend-direct, ``AGENT_API_KEY`` = (있을 때만)}.
    ``api_key_plaintext`` 가 없으면(미발급/회전·기존 sse 경로 동형) ``AGENT_API_KEY`` 키를 생략한다 —
    소비자(GET connection-artifact)가 placeholder 를 넣거나 사용자가 자기 키를 채운다(AC4: 기존
    SPRINTABLE_API_KEY fallback 호환·미발급 시 키 비노출).

    runtime 은 현재 ``claude-code`` 단일(향후 cursor 등 분기 여지). 미지원 값은 호출부(엔드포인트)가
    400 으로 거른다 — generator 는 항상 canonical stdio 아티팩트를 만든다.
    """
    env: dict[str, str] = {"SPRINTABLE_API_URL": resolve_backend_direct_url()}
    if api_key_plaintext:
        env["AGENT_API_KEY"] = api_key_plaintext
    return {
        "mcpServers": {
            "sprintable": {
                "type": "stdio",
                "command": "uvx",
                "args": ["sprintable-mcp"],
                "env": env,
            }
        }
    }
