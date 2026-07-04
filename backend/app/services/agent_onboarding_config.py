"""에이전트 온보딩 config 단일 SSOT generator (OB-1 · 블루프린트 §2/§7 + E-MCP-OPT S3).

team_members·agents 라우트 + connection-artifact API 가 **모두 이 generator 하나만** 소비한다 —
README·onboarding-form·in-app docs·로컬 buildMcpConfig 4갈래로 흩어져 모순되던 config 를 단일화.

두 transport 아티팩트를 생성한다(§2):
- **stdio** `.mcp.json`(로컬 uvx) — 툴+이벤트를 한 프로세스로 묶는다(§2/§3). ``SPRINTABLE_API_URL`` 은
  **backend-direct Cloud Run URL** — CF-fronted 깔끔 도메인은 ①/agent/stream SSE 버퍼링 ②봇차단
  때문에 금지(블루프린트 §2/§3·선생님 catch).
- **http**(E-MCP-OPT S3) — 호스팅(`sprintable-mcp-prod`) streamable-http, `MCP_PUBLIC_URL` 깔끔
  도메인 + per-request bearer. **tools-only**(이벤트 경로 분리 — SSE bridge 미구동, `agent_verify.py`
  가 transport-aware 축소 rail로 대응한다).
"""
from __future__ import annotations

import os

DEFAULT_RUNTIME = "claude-code"
SUPPORTED_RUNTIMES = frozenset({"claude-code"})
STDIO = "stdio"
HTTP = "http"
SUPPORTED_TRANSPORTS = frozenset({STDIO, HTTP})

_LOCAL_FALLBACK_URL = "http://localhost:8000"
# generator 가 backend-direct URL 을 읽는 런타임 env. 배포(deploy_backend.sh)가 주입한다.
# `_FASTAPI_URL`(cloudbuild)·`NEXT_PUBLIC_FASTAPI_URL`(FE)·`fastapi_url`(gh action) 컨벤션과 일치.
# ⚠️ `SPRINTABLE_API_URL`(=에이전트/MCP 측 env 이름)을 backend fallback 으로 읽지 않는다 — backend
# 런타임엔 미설정이고, 혹 CF 도메인으로 새어 들어오면 잘못 집을 footgun(PO QA). 단일 canonical 키.
_BACKEND_URL_ENV_KEY = "FASTAPI_URL"
# E-MCP-OPT S3: 호스팅 MCP 깔끔 도메인 — README(구·문서만 언급) 대신 실제로 read. 미설정(OSS/로컬 —
# 호스팅 배포 자체가 없음)이면 http 변형을 아예 생성하지 않는다(에러 아님·"그 탭 없음"이 정답).
_MCP_PUBLIC_URL_ENV_KEY = "MCP_PUBLIC_URL"


def resolve_backend_direct_url() -> str:
    """에이전트가 호출할 backend-direct Cloud Run URL.

    배포가 주입한 env(``FASTAPI_URL``) → 미설정(로컬)이면 localhost fallback. trailing slash 제거.
    **CF-fronted 깔끔 도메인 금지** — /agent/stream SSE 도달이 필수라 직통 run.app 이어야 한다.
    """
    val = os.environ.get(_BACKEND_URL_ENV_KEY, "").strip()
    return val.rstrip("/") if val else _LOCAL_FALLBACK_URL


def resolve_mcp_public_url() -> str | None:
    """호스팅 MCP 깔끔 도메인(``MCP_PUBLIC_URL``, 예 ``https://mcp.sprintable.ai/mcp``).

    미설정(OSS/로컬 등 호스팅 배포가 없는 환경) → None(http 변형 생성 불가 신호 — 호출부가 이를
    "그 옵션 자체가 없음"으로 취급한다. 에러 아님).
    """
    val = os.environ.get(_MCP_PUBLIC_URL_ENV_KEY, "").strip()
    return val.rstrip("/") if val else None


def default_transport_for_edition() -> str:
    """edition별 기본 transport — SaaS(EE)=http(무마찰 호스팅) / OSS=stdio(호스팅 배포 없음).

    기존 OSS/SaaS 스위치(``settings.is_ee_enabled``) 재사용 — 신규 플래그 0.
    """
    from app.core.config import settings

    return HTTP if settings.is_ee_enabled else STDIO


def _build_stdio_config(api_key_plaintext: str | None) -> dict:
    """stdio sprintable-mcp `.mcp.json` 아티팩트(SSOT · 블루프린트 §2).

    env = {``SPRINTABLE_API_URL`` = backend-direct, ``AGENT_API_KEY`` = (있을 때만)}.
    ``api_key_plaintext`` 가 없으면(미발급/회전·기존 sse 경로 동형) ``AGENT_API_KEY`` 키를 생략한다 —
    소비자(GET connection-artifact)가 placeholder 를 넣거나 사용자가 자기 키를 채운다(AC4: 기존
    SPRINTABLE_API_KEY fallback 호환·미발급 시 키 비노출).

    **OB-2-align — 두 SSE 시스템 통일(AC④)**: sse_bridge 는 ``AGENT_GATEWAY_V2`` env 로 수신 경로를
    가른다(sse_bridge.py). 두 경로 공존:
      - V2 ``/api/v2/agent/stream`` — ``AgentGatewaySession`` 생성·recipient_seq/acked_seq 커서.
        verify(OB-2)·단일경로 fix(5a99842b/c60dd33c)·presence 가 모두 이 경로를 가정. **canonical.**
      - 구 ``/api/v2/events/stream`` — in-memory ``_agent_connections``·세션/presence 미생성(legacy).
    flag 미설정이면 sse_bridge 가 **구 경로 default** → 신규 에이전트가 ``AgentGatewaySession`` 을
    안 만들어 verify ``mcp_reachable`` 가 false-negative(통합 dogfood 적출). 따라서 아티팩트에
    ``AGENT_GATEWAY_V2="1"`` 을 박아 신규 에이전트를 **V2 로 통일** — mcp_reachable+acked_seq 정렬로
    verified-green 이 성립한다(서버 무변경·기존 에이전트 무영향).
    """
    env: dict[str, str] = {
        "SPRINTABLE_API_URL": resolve_backend_direct_url(),
        "AGENT_GATEWAY_V2": "1",  # OB-2-align: 신규 에이전트를 V2 게이트웨이(/agent/stream)로 통일.
    }
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


def _build_http_config(api_key_plaintext: str | None) -> dict | None:
    """호스팅 streamable-http `.mcp.json` 변형(E-MCP-OPT S3).

    ``MCP_PUBLIC_URL`` 미설정이면 None(이 환경엔 호스팅 배포가 없다는 뜻 — 호출부가 변형을 생략).
    ``AGENT_API_KEY`` 는 env 가 아니라 **per-request bearer**(``Authorization`` 헤더)로 인증 —
    stdio 의 env-key 단일 인증과 다른 http transport 의 실제 인증 방식과 정합.
    """
    url = resolve_mcp_public_url()
    if url is None:
        return None
    headers: dict[str, str] = {}
    if api_key_plaintext:
        headers["Authorization"] = f"Bearer {api_key_plaintext}"
    return {
        "mcpServers": {
            "sprintable": {
                "type": "http",
                "url": url,
                "headers": headers,
            }
        }
    }


def build_agent_mcp_config(
    *,
    api_key_plaintext: str | None,
    runtime: str = DEFAULT_RUNTIME,
    transport: str = STDIO,
) -> dict | None:
    """`.mcp.json` 아티팩트 generator — transport 별 SSOT(E-MCP-OPT S3).

    runtime 은 현재 ``claude-code`` 단일(향후 cursor 등 분기 여지). 미지원 값은 호출부(엔드포인트)가
    400 으로 거른다 — generator 는 항상 canonical 아티팩트를 만든다.

    ``transport="http"`` 인데 이 환경에 호스팅 배포가 없으면(``MCP_PUBLIC_URL`` 미설정) None 반환 —
    호출부가 이를 "그 변형 생성 불가"로 취급(에러 아님).
    """
    if transport == HTTP:
        return _build_http_config(api_key_plaintext)
    return _build_stdio_config(api_key_plaintext)


def build_agent_mcp_config_bundle(
    *,
    api_key_plaintext: str | None,
    runtime: str = DEFAULT_RUNTIME,
) -> dict:
    """connect-step 토글용 — **두 transport 변형을 한 번에** 반환(FE round-trip 0, §5 SSOT 보존).

    ``{"default_transport": ..., "mcp_config": <default 변형>,
    "mcp_config_alternatives": {<다른 transport>: <그 변형>, ...}}``. http 변형이 이 환경에서
    생성 불가(``MCP_PUBLIC_URL`` 미설정)면 alternatives 에서 생략(OSS 는 호스팅 탭 자체가 없음).
    """
    default_transport = default_transport_for_edition()
    configs = {
        t: build_agent_mcp_config(api_key_plaintext=api_key_plaintext, runtime=runtime, transport=t)
        for t in SUPPORTED_TRANSPORTS
    }
    configs = {t: c for t, c in configs.items() if c is not None}
    default_config = configs.get(default_transport) or configs[STDIO]
    resolved_default = default_transport if default_transport in configs else STDIO
    alternatives = {t: c for t, c in configs.items() if t != resolved_default}
    return {
        "default_transport": resolved_default,
        "mcp_config": default_config,
        "mcp_config_alternatives": alternatives,
    }
