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
# E-RECRUIT S5(story 4fca5a3e) Q1(PO 확정): S4 픽커 그대로 — MCP-native 4(claude-code primary +
# codex/gemini/cursor, transport config 공통) + "connector" 통칭 1개(9종 SSE 어댑터 개별 확장 X).
CONNECTOR_RUNTIME = "connector"
MCP_NATIVE_RUNTIMES = frozenset({"claude-code", "codex", "gemini", "cursor"})
SUPPORTED_RUNTIMES = MCP_NATIVE_RUNTIMES | {CONNECTOR_RUNTIME}
STDIO = "stdio"
HTTP = "http"
SUPPORTED_TRANSPORTS = frozenset({STDIO, HTTP})

# E-RECRUIT S5 G4: 런타임별 자율 운영 지침 파일명 — 블루프린트 §4 어댑터 3축 중 "지침 파일명" 축.
# P0=claude-code 만 확정(CLAUDE.md); 나머지 MCP-native 런타임(codex=AGENTS.md·cursor=.cursorrules
# 등)의 정식 매핑은 S7 shaping(PO 확정) — 미확정 런타임은 이 기본값으로 폴백(크래시 없이 최선의
# 파일명 제공, 회귀 없이 확장 여지만 남김).
_INSTRUCTION_FILENAMES: dict[str, str] = {
    "claude-code": "CLAUDE.md",
}
_DEFAULT_INSTRUCTION_FILENAME = "AGENT_INSTRUCTIONS.md"


def resolve_instruction_filename(runtime: str) -> str:
    """런타임별 자율 운영 지침 파일명(어댑터 3축 중 하나). 미확정 런타임은 generic 기본값."""
    return _INSTRUCTION_FILENAMES.get(runtime, _DEFAULT_INSTRUCTION_FILENAME)


def build_connector_guidance(runtime_hint: str | None = None) -> str:
    """E-RECRUIT S5 Q2(PO 확정): connector 분기 = **포인터/안내만**(SSE dial-out은 `.mcp.json`과
    완전 별개 프로토콜 — 실제 어댑터 조립은 S7/후속). `connectors/{runtime}-sprintable/` 각 폴더의
    README가 5조 계약(SSE dial-out·turn 주입·응답·ack·에러)을 담고 있어 여기선 안내만 재생산한다."""
    lines = [
        "# Sprintable Connector 안내",
        "",
        "Claude Code/Codex/Gemini/Cursor 처럼 MCP를 네이티브 지원하지 않는 런타임은 별도 SSE",
        "커넥터 어댑터로 연결합니다 — `.mcp.json`이 아니라 `connectors/{runtime}-sprintable/` 폴더의",
        "어댑터를 사용해 서버에 아웃바운드로 접속합니다(인바운드 도메인/웹훅 불필요).",
        "",
        "## 사용 가능한 어댑터",
        "`connectors/` 레포 경로 아래 각 폴더가 자기완결(self-contained) 어댑터입니다:",
        "hermes-sprintable · openclaw-sprintable · opencode-sprintable · grok-sprintable ·",
        "pi-sprintable · codex-sprintable · cursor-sprintable · gemini-sprintable",
        "",
        "## 설정",
        "1. 위 폴더 중 사용 중인 런타임에 맞는 폴더를 복사하세요(각 폴더는 sibling import 없이",
        "   독립 동작합니다).",
        "2. 폴더의 `README.md` 안내대로 `AGENT_API_KEY`(이 에이전트의 scoped key) 등 env를 설정하세요.",
        "3. 어댑터를 런타임 호스트에서 직접 실행하세요(호스팅 실행은 지원하지 않음 — 설치/실행은",
        "   사용자 수동).",
    ]
    if runtime_hint:
        lines.insert(2, f"(선택한 런타임: {runtime_hint})")
    return "\n".join(lines)

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

    E-RECRUIT S5: MCP-native 런타임(``MCP_NATIVE_RUNTIMES`` — transport config 공통, PO 확정)만
    `.mcp.json`을 받는다. ``runtime == CONNECTOR_RUNTIME``이면 None(SSE dial-out은 완전 별개
    프로토콜이라 `.mcp.json` 자체가 성립 안 함 — 호출부가 ``build_connector_guidance()``로 대체).

    ``transport="http"`` 인데 이 환경에 호스팅 배포가 없으면(``MCP_PUBLIC_URL`` 미설정) None 반환 —
    호출부가 이를 "그 변형 생성 불가"로 취급(에러 아님).
    """
    if runtime == CONNECTOR_RUNTIME:
        return None
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

    E-RECRUIT S5: ``runtime == CONNECTOR_RUNTIME``이면 mcp_config 자체가 성립 안 하므로 전부 None/
    빈값(호출부가 ``build_connector_guidance()``로 안내 파일을 대신 emit — crash 대신 안전한 no-op).
    """
    if runtime == CONNECTOR_RUNTIME:
        return {"default_transport": None, "mcp_config": None, "mcp_config_alternatives": {}}

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
