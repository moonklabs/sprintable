"""에이전트 런타임 capability registry (E-CHAT-CMD S1 토대).

블루프린트 `blueprint-chat-command-skill-execution` §Task 1 / 리서치 매트릭스
`research-chat-command-skill-execution-across-runtimes`.

런타임별 "결정적(deterministic) 커맨드" 실행 가능 여부의 정적 레지스트리. 채팅 명령 →
에이전트 커맨드/스킬 실행 경로(S3 classifier·S9 allowlist 등)가 이 단일 SSOT 를 참조한다.

- **deterministic_command**: 런타임이 결정적 커맨드(모델 비경유, 직접 실행)를 지원하는가.
- **command_endpoint_available**: 커맨드 주입 엔드포인트가 존재하는가. opencode 는 엔드포인트는
  있으나 결정적 실행은 아님(deterministic_command=False, endpoint=True).
- **skill**: 스킬 실행 방식 — 전 런타임 `model-mediated`(결정적 스킬 실행 없음).

근거 매트릭스(리서치):
  hermes·openclaw·gemini·grok·pi  → deterministic_command=True  (endpoint 당연 available)
  opencode                        → deterministic_command=False, command_endpoint_available=True
  claude-code·codex·cursor        → deterministic_command=False, command_endpoint_available=False
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

SKILL_MODEL_MEDIATED = "model-mediated"


class RuntimeType(str, Enum):
    """member.runtime_type 의 허용 9종(앱 레이어 강제)."""

    OPENCODE = "opencode"
    OPENCLAW = "openclaw"
    HERMES = "hermes"
    GEMINI = "gemini"
    GROK = "grok"
    CURSOR = "cursor"
    CODEX = "codex"
    PI = "pi"
    CLAUDE_CODE = "claude-code"


@dataclass(frozen=True)
class RuntimeCapability:
    """런타임의 커맨드/스킬 실행 capability."""

    deterministic_command: bool
    command_endpoint_available: bool
    skill: str = SKILL_MODEL_MEDIATED


# 미지원(빈값/unknown runtime) 기본값 — 보수적: 결정적 커맨드·엔드포인트 모두 없음.
UNSUPPORTED_CAPABILITY = RuntimeCapability(
    deterministic_command=False, command_endpoint_available=False
)

_CAPABILITY_REGISTRY: dict[RuntimeType, RuntimeCapability] = {
    # 결정적 커맨드 지원 — 엔드포인트 당연 available
    RuntimeType.HERMES: RuntimeCapability(deterministic_command=True, command_endpoint_available=True),
    RuntimeType.OPENCLAW: RuntimeCapability(deterministic_command=True, command_endpoint_available=True),
    RuntimeType.GEMINI: RuntimeCapability(deterministic_command=True, command_endpoint_available=True),
    RuntimeType.GROK: RuntimeCapability(deterministic_command=True, command_endpoint_available=True),
    RuntimeType.PI: RuntimeCapability(deterministic_command=True, command_endpoint_available=True),
    # 엔드포인트는 있으나 결정적 실행 아님
    RuntimeType.OPENCODE: RuntimeCapability(deterministic_command=False, command_endpoint_available=True),
    # 커맨드 엔드포인트 자체 없음 — 스킬은 model-mediated 만
    RuntimeType.CLAUDE_CODE: RuntimeCapability(deterministic_command=False, command_endpoint_available=False),
    RuntimeType.CODEX: RuntimeCapability(deterministic_command=False, command_endpoint_available=False),
    RuntimeType.CURSOR: RuntimeCapability(deterministic_command=False, command_endpoint_available=False),
}


def get_runtime_capability(runtime_type: str | RuntimeType | None) -> RuntimeCapability:
    """runtime_type → capability. 빈값/unknown 은 UNSUPPORTED_CAPABILITY(미지원).

    member.runtime_type(nullable Text)를 직접 넘겨도 안전 — None/빈문자열/미등록 문자열 모두
    보수적으로 미지원 처리(AC3). 알 수 없는 런타임을 '지원'으로 오판하지 않는다.
    """
    if not runtime_type:
        return UNSUPPORTED_CAPABILITY
    try:
        rt = RuntimeType(runtime_type)
    except ValueError:
        return UNSUPPORTED_CAPABILITY
    return _CAPABILITY_REGISTRY[rt]


def supports_deterministic_command(runtime_type: str | RuntimeType | None) -> bool:
    """편의 헬퍼: 결정적 커맨드 지원 여부(S3 classifier 등 진입점에서 사용)."""
    return get_runtime_capability(runtime_type).deterministic_command
