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
from typing import Any

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

# E-I18N Phase A(story 11f1087c, 문서 `i18n-architecture-design-crux`, 선생님 GO
# 2026-07-08): FE `apps/web/src/i18n/request.ts`의 `SUPPORTED_LOCALES=['en','ko']`와
# 값을 정확히 일치시킨 BE SSOT — 둘이 어긋나면 "FE는 지원한다는데 BE가 거부" 류 불일치
# 버그가 재발한다. DEFAULT_LOCALE은 FE와 달리 **ko**다(FE 기본값은 en이지만, 그건
# "브라우저 방문자가 아무 신호도 없을 때"의 기본이고, 여긴 반대로 "오늘 유일하게 실
# 콘텐츠가 존재하는 locale"이 기준 — role_templates/코드 상수 전부 한글이 원본이라
# en 콘텐츠가 아직 없는 동안은 ko가 안전한 폴백).
SUPPORTED_LOCALES = ("ko", "en")
DEFAULT_LOCALE = "ko"


def resolve_locale(locale: str | None) -> str:
    """미지원/None locale → DEFAULT_LOCALE 폴백(크래시 없이 항상 유효한 locale 반환)."""
    return locale if locale in SUPPORTED_LOCALES else DEFAULT_LOCALE


def resolve_locale_from_request(explicit: str | None, accept_language: str | None) -> str:
    """E-I18N Phase C(story 11f1087c, 문서 `i18n-architecture-design-crux` §1 결정 (a)+(b)):
    콘텐츠-생성 엔드포인트의 locale 소스 우선순위 — ① FE가 명시 전달한 ``locale``(자기
    next-intl locale 쿠키값, 가장 정확) ② 없으면 ``Accept-Language`` 헤더에서 유도(브라우저
    기본 — FE 미변경 클라이언트에도 무회귀 폴백) ③ 그래도 없으면 ``DEFAULT_LOCALE``.

    DB 영속 저장 없음(request-scoped) — org/user에 locale 컬럼을 두지 않는다는 crux 결정과 동형
    (FE도 쿠키만 쓰고 DB엔 안 둔다 — 대칭 유지).
    """
    if explicit:
        return resolve_locale(explicit)
    if accept_language:
        for tag in accept_language.split(","):
            primary = tag.split(";", 1)[0].strip().split("-", 1)[0].lower()
            if primary in SUPPORTED_LOCALES:
                return primary
    return DEFAULT_LOCALE

# 채용-kit 재설계(story b1fe41cf, 문서 `recruit-output-kit-redesign-crux`, 선생님 GO
# 2026-07-08 결정①): 예전엔 런타임별 CLAUDE.md/GEMINI.md/AGENTS.md **리터럴**을 다운로드
# 파일명으로 썼다 — 유저가 그 파일명 그대로 프로젝트 루트에 저장하면 자기 에이전트의 **실제
# 기존 정체성 파일을 덮어썼다**(선생님이 지적한 정체성 뭉갬의 실제 코드 지점). 이제 런타임 무관
# **단일** 파일명(그 어떤 런타임의 실 정체성 파일명과도 충돌하지 않는 이름)으로 통일 — 유저가
# 이 파일을 "자기 에이전트에게 건네" 자기화하게 하는 kit 모델(§크럭스 2/3).
KIT_FILENAME = "SPRINTABLE_ONBOARDING.md"


def resolve_instruction_filename(runtime: str) -> str:
    """자율 운영 kit 파일명 — 채용-kit 재설계 이후 런타임 무관 단일 상수(KIT_FILENAME).

    함수 시그니처(런타임 인자)는 호출부 변경을 최소화하려 유지하지만, 반환값은 이제 런타임에
    의존하지 않는다(예전엔 CLAUDE.md/GEMINI.md/AGENTS.md로 갈렸음 — 정체성 파일 충돌 버그의
    원인이라 제거)."""
    return KIT_FILENAME


# 유나 라이브픽셀 발견(2026-07-08, 승격 前 fix): 위 KIT_FILENAME/resolve_instruction_filename은
# "우리가 쓰는 kit 파일"(런타임 무관, 의도된 단일 상수) 개념인데, list_runtime_capabilities()의
# ``prompt_file``은 그와 **다른** 개념 — "그 런타임 자신의 기존 정체성 지침 파일명"(FE STEP4
# 전달노트가 "기존 X 파일은 그대로 둬라"에 채워 넣는 값)이다. #1967/#1974가 이 둘을 conflate해
# 전 런타임에 SPRINTABLE_ONBOARDING.md를 반환 — "기존 SPRINTABLE_ONBOARDING.md 그대로"라는
# 자기모순 문구를 냈다(SPRINTABLE_ONBOARDING.md는 방금 새로 놓이는 파일이지 "기존" 파일이 아님).
# apps/web/src/services/recruit.ts::RUNTIME_CAPABILITIES_FALLBACK(2026-07-08 동기화판)과 값을
# 맞춘다 — claude-code/codex/gemini만 실제 컨벤션 리터럴, connector(범용 버킷)는
# AGENT_INSTRUCTIONS.md, 나머지(cursor + 커넥터 전용 5종)는 S7 shaping 전 generic fallback으로
# AGENTS.md.
_RUNTIME_PROMPT_FILENAMES: dict[str, str] = {
    "claude-code": "CLAUDE.md",
    "codex": "AGENTS.md",
    "gemini": "GEMINI.md",
    CONNECTOR_RUNTIME: "AGENT_INSTRUCTIONS.md",
}
_DEFAULT_RUNTIME_PROMPT_FILENAME = "AGENTS.md"


def resolve_runtime_prompt_filename(runtime: str) -> str:
    """런타임 자신의 기존 정체성 지침 파일명 — resolve_instruction_filename()(kit write-target,
    런타임 무관 단일 상수)과는 별개 개념이니 혼동 금지."""
    return _RUNTIME_PROMPT_FILENAMES.get(runtime, _DEFAULT_RUNTIME_PROMPT_FILENAME)


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
    tier는 구체적으로 이름 붙은 런타임이면 "full", 범용 ``connector`` 버킷(특정 런타임을 못
    찾았을 때의 안내-only 폴백)이면 "experimental" — 원래 의도(구체 런타임 vs 범용 폴백)를
    직접 표현한다(``prompt_file``에 더는 얹지 않음 — 아래 참고).

    ``prompt_file``은 kit 파일명(KIT_FILENAME)이 **아니다** — 그 런타임 자신의 기존 정체성
    지침 파일명이다(resolve_runtime_prompt_filename() 참고, 유나 라이브픽셀 발견 fix).

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
                else "experimental" if runtime == CONNECTOR_RUNTIME
                else "full"
            ),
            "transport": None if (is_connector_routed or not supported) else default_transport_for_hosting(),
            "mcp_transport": [] if (is_connector_routed or not supported) else sorted(SUPPORTED_TRANSPORTS),
            "prompt_file": resolve_runtime_prompt_filename(runtime) if supported else None,
            "guide_filename": "CONNECTOR_SETUP.md" if is_connector_routed else None,
            "supports_event_push": supported and not is_connector_routed,
            "icon": None,
        })
    return out


_CONNECTOR_GUIDANCE_TEXT: dict[str, dict[str, Any]] = {
    "ko": {
        "title": "# Sprintable Connector 안내",
        "intro": [
            "Claude Code/Codex/Gemini/Cursor 처럼 MCP를 네이티브 지원하지 않는 런타임은 별도 SSE",
            "커넥터 어댑터로 연결합니다 — `.mcp.json`이 아니라 `connectors/{runtime}-sprintable/` 폴더의",
            "어댑터를 사용해 서버에 아웃바운드로 접속합니다(인바운드 도메인/웹훅 불필요).",
        ],
        "adapters_heading": "## 사용 가능한 어댑터",
        "adapters_intro": "`connectors/` 레포 경로 아래 각 폴더가 자기완결(self-contained) 어댑터입니다:",
        "setup_heading": "## 설정",
        # 까심 QA MUST-FIX(2026-07-08, #1966): dict화 전 원문의 줄바꿈(1·3번 항목이 2줄로
        # 쪼개져 있었음)을 그대로 보존 — PR이 "default-ko 100% 무변경"이라 주장했는데 실제로는
        # 한 줄로 합쳐져 byte-diff가 있었다. 여기 임베드된 "\n   "이 원문 join 결과를 재현한다.
        "setup_steps": [
            "위 폴더 중 사용 중인 런타임에 맞는 폴더를 복사하세요(각 폴더는 sibling import 없이\n   독립 동작합니다).",
            "폴더의 `README.md` 안내대로 `AGENT_API_KEY`(이 에이전트의 scoped key) 등 env를 설정하세요.",
            "어댑터를 런타임 호스트에서 직접 실행하세요(호스팅 실행은 지원하지 않음 — 설치/실행은\n   사용자 수동).",
        ],
        "runtime_hint": "(선택한 런타임: {runtime})",
    },
    "en": {
        "title": "# Sprintable Connector Guide",
        "intro": [
            "Runtimes that don't natively support MCP (e.g. Claude Code/Codex/Gemini/Cursor don't",
            "need this — this is for the rest) connect via a separate SSE connector adapter instead",
            "of `.mcp.json` — the adapter in `connectors/{runtime}-sprintable/` dials out to the",
            "server (no inbound domain/webhook needed).",
        ],
        "adapters_heading": "## Available Adapters",
        "adapters_intro": "Each folder under the `connectors/` repo path is a self-contained adapter:",
        "setup_heading": "## Setup",
        "setup_steps": [
            "Copy the folder matching your runtime (each folder is self-contained, no sibling imports).",
            "Set env vars per the folder's `README.md` (including `AGENT_API_KEY`, this agent's scoped key).",
            "Run the adapter yourself on your runtime host (hosted execution isn't supported — install/run manually).",
        ],
        "runtime_hint": "(Selected runtime: {runtime})",
    },
}


def build_connector_guidance(runtime_hint: str | None = None, locale: str = DEFAULT_LOCALE) -> str:
    """E-RECRUIT S5 Q2(PO 확정): connector 분기 = **포인터/안내만**(SSE dial-out은 `.mcp.json`과
    완전 별개 프로토콜 — 실제 어댑터 조립은 S7/후속). `connectors/{runtime}-sprintable/` 각 폴더의
    README가 5조 계약(SSE dial-out·turn 주입·응답·ack·에러)을 담고 있어 여기선 안내만 재생산한다.

    E-I18N Phase C(story 11f1087c) — locale 분기(compose_prompt류와 동형 dict 패턴). 기본값
    ``DEFAULT_LOCALE``이라 기존 호출부(locale 인자 없이 호출)는 **byte-identical** 하위호환
    (까심 QA MUST-FIX: dict화 시 실수로 원문 줄바꿈이 사라졌던 걸 복원 — 아래 realdb 테스트가
    아니라 유닛 테스트가 원문 리터럴과 정확히 일치하는지 직접 assert한다).
    """
    text = _CONNECTOR_GUIDANCE_TEXT[resolve_locale(locale)]
    lines = [text["title"], "", *text["intro"], "", text["adapters_heading"], text["adapters_intro"],
        "hermes-sprintable · openclaw-sprintable · opencode-sprintable · grok-sprintable ·",
        "pi-sprintable · codex-sprintable · cursor-sprintable · gemini-sprintable",
        "", text["setup_heading"]]
    lines += [f"{i}. {step}" for i, step in enumerate(text["setup_steps"], 1)]
    if runtime_hint:
        lines.insert(2, text["runtime_hint"].format(runtime=runtime_hint))
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
