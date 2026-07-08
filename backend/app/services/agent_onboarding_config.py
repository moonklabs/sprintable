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
# 전 런타임 올지원(story 6f6ac081, 문서 `runtime-full-support-firstclass-crux`, PO GO
# 2026-07-08): MCP-native 4(claude-code/codex/gemini/cursor, transport config 공통) +
# 커넥터 전용 5(opencode/openclaw/hermes/grok/pi, 실 SSE 어댑터가 connectors/ 에 이미 존재 —
# vaporware 아님) + 범용 "connector" 버킷(어댑터가 따로 없는 런타임용 포인터 안내).
CONNECTOR_RUNTIME = "connector"
MCP_NATIVE_RUNTIMES = frozenset({"claude-code", "codex", "gemini", "cursor"})
CONNECTOR_ONLY_RUNTIMES = frozenset({"opencode", "openclaw", "hermes", "grok", "pi"})
SUPPORTED_RUNTIMES = MCP_NATIVE_RUNTIMES | CONNECTOR_ONLY_RUNTIMES | {CONNECTOR_RUNTIME}
STDIO = "stdio"
HTTP = "http"
SUPPORTED_TRANSPORTS = frozenset({STDIO, HTTP})

# E-RECRUIT S5 G4 + 전 런타임 올지원(story 6f6ac081) — 런타임별 자율 운영 지침 파일명. 공식
# 문서 실측(추측 0, crux doc에 출처 전부 명시): codex/cursor/grok/pi/hermes/openclaw/opencode
# 7종이 `AGENTS.md`로 수렴(신흥 cross-tool 표준) — gemini만 `GEMINI.md` 예외. hermes는 우선순위
# 체인(.hermes.md/HERMES.md→AGENTS.md→CLAUDE.md→.cursorrules)이라 우리가 AGENTS.md 하나만
# emit해도 그 체인에서 정상 로드된다(더 앞순위 파일은 우리 쪽에서 안 만듦).
_INSTRUCTION_FILENAMES: dict[str, str] = {
    "claude-code": "CLAUDE.md",
    "gemini": "GEMINI.md",
    "codex": "AGENTS.md",
    "cursor": "AGENTS.md",
    "grok": "AGENTS.md",
    "pi": "AGENTS.md",
    "hermes": "AGENTS.md",
    "openclaw": "AGENTS.md",
    "opencode": "AGENTS.md",
}
_DEFAULT_INSTRUCTION_FILENAME = "AGENT_INSTRUCTIONS.md"


def resolve_instruction_filename(runtime: str) -> str:
    """런타임별 자율 운영 지침 파일명(어댑터 3축 중 하나). 미확정 런타임은 generic 기본값."""
    return _INSTRUCTION_FILENAMES.get(runtime, _DEFAULT_INSTRUCTION_FILENAME)


_RUNTIME_DISPLAY_NAMES: dict[str, str] = {
    "claude-code": "Claude Code",
    "codex": "Codex",
    "gemini": "Gemini",
    "cursor": "Cursor",
    "opencode": "OpenCode",
    "openclaw": "OpenClaw",
    "hermes": "Hermes",
    "grok": "Grok",
    "pi": "Pi",
    CONNECTOR_RUNTIME: "Connector",
}


def list_runtime_capabilities() -> list[dict]:
    """S6(유나/미르코 정합용) `GET /api/v2/runtime-capabilities` 계약 SSOT.

    supported/tier는 **S5 emit 코드 실기준**(과대약속 금지) — recruiter/connection-artifact가
    그 런타임으로 실제 아티팩트를 만들 수 있으면 supported=true. 전 런타임 올지원(story
    6f6ac081) 이후: MCP-native 4종은 `.mcp.json`(transport 선택 가능), 나머지 지원 런타임
    (커넥터 전용 5종 + 범용 connector 버킷)은 전부 SSE 커넥터 경로(CONNECTOR_SETUP.md, transport
    개념 자체가 없음) — 이 두 그룹의 경계가 ``MCP_NATIVE_RUNTIMES``(``is_connector_routed``)다.
    tier는 ``_INSTRUCTION_FILENAMES``에 확정 매핑이 있으면 "full"(모든 지원 런타임이 이제 여기
    포함 — 축2 완료), 없으면(현재 없음, 확장 여지만 유지) "experimental".

    PO 확인(2026-07-06): FE 픽커의 "곧 지원" 섹션이 채워지려면 **미지원 런타임도 응답에
    포함**돼야 한다 — ``RuntimeType``(agent_runtime.py, member.runtime_type 9종 SSOT) 전부가
    이제 ``SUPPORTED_RUNTIMES``에 있어 "곧 지원" 섹션은 비게 된다(의도된 결과 — 전 런타임
    올지원이 이 스토리의 목표).
    """
    from app.services.agent_runtime import RuntimeType

    out = []
    all_slugs = sorted({rt.value for rt in RuntimeType} | SUPPORTED_RUNTIMES)
    for runtime in all_slugs:
        supported = runtime in SUPPORTED_RUNTIMES
        is_connector_routed = supported and runtime not in MCP_NATIVE_RUNTIMES
        out.append({
            "slug": runtime,
            "display_name": _RUNTIME_DISPLAY_NAMES.get(runtime, runtime),
            "supported": supported,
            "tier": (
                None if not supported
                else "full" if runtime in _INSTRUCTION_FILENAMES
                else "experimental"
            ),
            "transport": None if (is_connector_routed or not supported) else default_transport_for_hosting(),
            "mcp_transport": [] if (is_connector_routed or not supported) else sorted(SUPPORTED_TRANSPORTS),
            "prompt_file": resolve_instruction_filename(runtime) if supported else None,
            "guide_filename": "CONNECTOR_SETUP.md" if is_connector_routed else None,
            "supports_event_push": supported and not is_connector_routed,
            "icon": None,
        })
    return out


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


def default_transport_for_hosting() -> str:
    """호스팅 가용성별 기본 transport — MCP_PUBLIC_URL 세팅됨(호스팅 MCP 가용)=http(무마찰) /
    미설정(자체호스팅·호스팅 배포 없음)=stdio.

    E-MCP-OPT S7(선생님 지적 2026-07-04·S3 근본 fix): 예전엔 ``settings.is_ee_enabled``(과금
    스위치)로 갈랐으나, 이는 틀린 커플링 — EE 꺼진 배포(예: dev 기본값)에서도 호스팅 MCP가 실제로
    떠 있으면(``MCP_PUBLIC_URL`` 세팅) 그 호스팅을 기본으로 써야 무마찰이 성립한다. 과금/EE 여부와
    무관하게 "호스팅 MCP가 있느냐"만으로 판정 — ``resolve_mcp_public_url()``(= ``_build_http_config()``
    non-None 가드)과 동일 신호를 재사용해 판정 신호가 하나로 정합된다.
    """
    return HTTP if resolve_mcp_public_url() is not None else STDIO


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

    E-RECRUIT S21(story 444d1d18, 2026-07-07): PyPI 미게시 동안 ``uvx --from git+<repo>#subdirectory=...``
    로 우회 emit했었음. OB-PUBLISH(f5e1742d)가 ``sprintable`` 0.1.0을 PyPI에 실게시(dist/콘솔
    스크립트명 = ``sprintable``, 모듈명은 ``sprintable_mcp`` 그대로) → 이 스토리(d306eb82)가 그
    우회를 걷어내고 bare ``uvx sprintable`` 로 원복. 로컬에서 ``uvx sprintable`` 실행해 실 PyPI
    resolve+fail-fast(env 미설정 에러 도달)까지 재확인 완료.
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
                "args": ["sprintable"],
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

    E-RECRUIT S5 + 전 런타임 올지원(story 6f6ac081): MCP-native 런타임(``MCP_NATIVE_RUNTIMES`` —
    transport config 공통, PO 확정)만 `.mcp.json`을 받는다. 그 외(범용 ``connector`` 버킷 +
    커넥터 전용 5종 ``CONNECTOR_ONLY_RUNTIMES``)는 전부 None(SSE dial-out은 완전 별개 프로토콜이라
    `.mcp.json` 자체가 성립 안 함 — 호출부가 ``build_connector_guidance()``로 대체). 가드를
    단일 sentinel(``== CONNECTOR_RUNTIME``) 대신 ``not in MCP_NATIVE_RUNTIMES``로 반전한 이유:
    전자는 커넥터 전용 5종을 그냥 통과시켜 `.mcp.json`을 오emit했다(PO 크럭스 승인 fix).

    ``transport="http"`` 인데 이 환경에 호스팅 배포가 없으면(``MCP_PUBLIC_URL`` 미설정) None 반환 —
    호출부가 이를 "그 변형 생성 불가"로 취급(에러 아님).
    """
    if runtime not in MCP_NATIVE_RUNTIMES:
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

    E-RECRUIT S5 + 전 런타임 올지원(story 6f6ac081): MCP-native가 아니면(범용 connector 버킷 +
    커넥터 전용 5종) mcp_config 자체가 성립 안 하므로 전부 None/빈값(호출부가
    ``build_connector_guidance()``로 안내 파일을 대신 emit — crash 대신 안전한 no-op).
    """
    if runtime not in MCP_NATIVE_RUNTIMES:
        return {"default_transport": None, "mcp_config": None, "mcp_config_alternatives": {}}

    default_transport = default_transport_for_hosting()
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
