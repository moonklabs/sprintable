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

import re
from dataclasses import dataclass
from enum import Enum
from typing import Annotated

from pydantic import AfterValidator

SKILL_MODEL_MEDIATED = "model-mediated"

# story 5011 (5008 audit): what a run profile may name for a runtime — kept IN the registry row, so turning a runtime on can never leave the model / effort tables
# behind (the old tables were two static dicts of the first two runtimes: an enabled new runtime saved with a model was a KeyError → 500).
_CLAUDE_EFFORTS = ("low", "medium", "high", "xhigh", "max")
_CODEX_SOL_EFFORTS = ("low", "medium", "high", "xhigh", "max", "ultra")
_CODEX_LUNA_EFFORTS = ("low", "medium", "high", "xhigh", "max")
_CODEX_COMMON_EFFORTS = ("low", "medium", "high", "xhigh")  # what every Codex model takes
# a typed-in model name goes on a command line: no space, quote, `=`, `;`, bracket, nor a leading `-` (§2)
MODEL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$")
# Claude takes its 1M-context id as the name with a «[1m]» tail · that one tail only, Claude only — the daemon's rule too (tests/fixtures/model-name-vectors.json)
CLAUDE_MODEL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}(\[1m\])?$")


@dataclass(frozen=True)
class RunProfileChoices:
    """The model and effort a run profile of one runtime may name. EMPTY (NO_CHOICES) is allowed: that runtime's profile is saved as «model · effort not named» only."""

    models: tuple[tuple[str, tuple[str, ...]], ...] = ()  # the listed models, each with the efforts it takes (order = the list the web shows)
    custom_efforts: tuple[str, ...] = ()  # the efforts for a typed-in model name or no model (the runtime's own default)
    model_pattern: re.Pattern[str] | None = None  # what a typed-in model name must match; None = no model may be named

    @property
    def is_empty(self) -> bool:
        return not self.models and not self.custom_efforts and self.model_pattern is None


NO_CHOICES = RunProfileChoices()


@dataclass(frozen=True)
class DesktopRuntime:
    """One row of the desktop runtime registry (story 5008 · A1)."""

    id: str  # the id the desktop app uses on the wire
    member_type: str  # members.runtime_type
    enabled: bool  # an app is offered this runtime today (the name is allowed in the tables either way)
    capability: str | None = None  # an app must say it can take it when it asks for a code; None = every app can
    agent_name: str = ""  # what a new agent of this runtime is called when the person picked it (the solo start)
    # story 5011: the run profile's model · effort lists. None = the row forgot it (a test turns red for an ENABLED row); NO_CHOICES = none to name, said on purpose
    choices: RunProfileChoices | None = None


# story 5008 (A1 · plan 796e269f): the desktop runtimes — the ONE list. Everything below is derived from it: the id → member type table, the names the
# check constraints of the three relay tables allow (migration 0497), the capability words a setup code may carry, the request-body validator.
# To add an agent: put it here with enabled=False (the name is then allowed in the tables and nothing else changes), build its adapter, flip enabled.
DESKTOP_RUNTIME_REGISTRY: tuple[DesktopRuntime, ...] = (
    # Listed = a start with it opens the conversation with no question (민 19:32Z · 4540-ac0 model-probe): gpt-5.5 is left out (its TUI stops at a retirement notice before any thread starts).
    # A typed-in name is still allowed (checked at its first start · 명세 C-5). Bracketed aliases (`opus[1m]`) are not listed. Codex efforts are per model (`codex debug models`).
    DesktopRuntime("claude", "claude-code", True, None, "Claude Code", RunProfileChoices(
        models=(("fable", _CLAUDE_EFFORTS), ("opus", _CLAUDE_EFFORTS), ("sonnet", _CLAUDE_EFFORTS)),
        custom_efforts=_CLAUDE_EFFORTS, model_pattern=CLAUDE_MODEL_NAME)),
    DesktopRuntime("codex", "codex", True, None, "Codex", RunProfileChoices(
        models=(
            ("gpt-6.1-sol", _CODEX_SOL_EFFORTS), ("gpt-6-astra", _CODEX_SOL_EFFORTS), ("gpt-6-sol", _CODEX_SOL_EFFORTS), ("gpt-6-luna", _CODEX_LUNA_EFFORTS),
            ("gpt-5.6-sol", _CODEX_SOL_EFFORTS), ("gpt-5.6-terra", _CODEX_SOL_EFFORTS), ("gpt-5.6-luna", _CODEX_LUNA_EFFORTS),
        ),
        custom_efforts=_CODEX_COMMON_EFFORTS, model_pattern=MODEL_NAME)),
    # the other three name no model or effort for now (their lists are filled when their adapter lands) — saved as «not named» only
    # story 5009 (A2): OpenCode is switched ON — offered only to an app that says rt-opencode
    DesktopRuntime("opencode", "opencode", True, "rt-opencode", "OpenCode", NO_CHOICES),
    DesktopRuntime("gemini", "gemini", False, "rt-gemini", "Gemini CLI", NO_CHOICES),
    DesktopRuntime("cursor", "cursor", False, "rt-cursor", "Cursor", NO_CHOICES),
)

# every name a relay table may hold (the check constraints' set — enabled or not)
DESKTOP_RUNTIME_IDS: tuple[str, ...] = tuple(r.id for r in DESKTOP_RUNTIME_REGISTRY)

# story 4680 (UX-1 · D2): the desktop app's runtime ids → members.runtime_type — the ENABLED rows of the registry (desktop_setup.py binds with it,
# runtime_capabilities carries its inverse as `desktop_runtime`, so the web never keeps a table of its own). A mutable dict on purpose: a test
# puts a «newer» runtime into it to show an older reader's behaviour.
DESKTOP_RUNTIME_TYPES: dict[str, str] = {r.id: r.member_type for r in DESKTOP_RUNTIME_REGISTRY if r.enabled}

# the capability words an app may add to a setup code to say «I can drive this runtime» (a server that does not know the word drops it)
RUNTIME_CAPABILITIES: tuple[str, ...] = tuple(r.capability for r in DESKTOP_RUNTIME_REGISTRY if r.capability)


def run_profile_choices(member_type: str) -> RunProfileChoices:
    """What a run profile of the runtime with this members.runtime_type may name. A runtime the registry does not know (a test's «newer» one) names nothing."""
    for r in DESKTOP_RUNTIME_REGISTRY:
        if r.member_type == member_type:
            return r.choices or NO_CHOICES
    return NO_CHOICES


def runtime_offered_to(runtime_id: str, capabilities: list[str] | None) -> bool:
    """May a setup that said these capabilities be given this runtime? (enabled, and — when the runtime needs one — the app said it can)."""
    if runtime_id not in DESKTOP_RUNTIME_TYPES:
        return False
    cap = next((r.capability for r in DESKTOP_RUNTIME_REGISTRY if r.id == runtime_id), None)
    return cap is None or cap in (capabilities or [])


def _is_offered_runtime(value: str) -> str:
    if value not in DESKTOP_RUNTIME_TYPES:
        raise ValueError("runtime_unsupported")  # one closed word, not a list of the names we do have
    return value


# a runtime id an APP sends us (request bodies): any enabled one; anything else is «runtime_unsupported».
# A runtime id WE send back (response models) is a plain `str`: a name a table holds must never turn an answer into a 500 for a reader that does not know it.
DesktopRuntimeId = Annotated[str, AfterValidator(_is_offered_runtime)]


def desktop_runtime_of(runtime_type: str) -> str | None:
    """`claude-code` → `claude` · `codex` → `codex` · anything else → None (no desktop app runs it)."""
    for desktop, member in DESKTOP_RUNTIME_TYPES.items():
        if member == runtime_type:
            return desktop
    return None


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
    # E-CHAT-CMD S7 — OpenCode wiring 결정(블루프린트 §Task 7):
    #   **MVP = unsupported hint**(deterministic_command=False). opencode 는 전용 커맨드
    #   엔드포인트(`POST /session/:id/command`)가 존재하나(command_endpoint_available=True),
    #   MVP 단순성을 위해 dedicated adapter 를 배선하지 않고 다른 비-결정적 런타임과 동일하게
    #   capability gate(S4)가 차단+hint 처리한다. → 사용자에게 "이 런타임은 결정적 커맨드 미지원,
    #   일반 메시지로 요청" 안내. ⚠️ **Phase2 후보**: command_endpoint_available=True 가 표식 —
    #   향후 dedicated command endpoint adapter 를 배선하면 opencode 만 deterministic_command=True
    #   로 승격 가능(다른 endpoint-없는 런타임과 구분되는 유일 케이스). 그때까지 기본값 유지.
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
