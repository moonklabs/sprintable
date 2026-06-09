"""E-CHAT-CMD S1 AC2/AC3: 런타임 capability registry + lookup 단위 테스트.

근거 매트릭스(리서치): deterministic_command —
  hermes·openclaw·gemini·grok·pi = True / opencode·claude-code·codex·cursor = False.
  command_endpoint_available — opencode 만 True(among non-deterministic).
  skill — 전 런타임 model-mediated.
"""
from app.services.agent_runtime import (
    SKILL_MODEL_MEDIATED,
    UNSUPPORTED_CAPABILITY,
    RuntimeType,
    get_runtime_capability,
    supports_deterministic_command,
)


def test_runtime_type_has_exactly_nine_enum_values():
    expected = {
        "opencode", "openclaw", "hermes", "gemini", "grok",
        "cursor", "codex", "pi", "claude-code",
    }
    assert {r.value for r in RuntimeType} == expected
    assert len(RuntimeType) == 9


def test_deterministic_command_matrix():
    """결정적 커맨드 지원 매트릭스 — 리서치 근거 그대로."""
    supported = {"hermes", "openclaw", "gemini", "grok", "pi"}
    unsupported = {"opencode", "claude-code", "codex", "cursor"}
    for rt in supported:
        assert get_runtime_capability(rt).deterministic_command is True, f"{rt} 결정적 커맨드 True 여야"
    for rt in unsupported:
        assert get_runtime_capability(rt).deterministic_command is False, f"{rt} 결정적 커맨드 False 여야"


def test_opencode_endpoint_available_but_not_deterministic():
    """opencode: 엔드포인트는 있으나 결정적 실행 아님(특수 케이스)."""
    cap = get_runtime_capability("opencode")
    assert cap.deterministic_command is False
    assert cap.command_endpoint_available is True


def test_command_endpoint_availability_matrix():
    # 결정적 지원 런타임 + opencode = 엔드포인트 available
    for rt in ("hermes", "openclaw", "gemini", "grok", "pi", "opencode"):
        assert get_runtime_capability(rt).command_endpoint_available is True, f"{rt} endpoint available 여야"
    # claude-code·codex·cursor = 엔드포인트 없음
    for rt in ("claude-code", "codex", "cursor"):
        assert get_runtime_capability(rt).command_endpoint_available is False, f"{rt} endpoint 없어야"


def test_skill_is_model_mediated_for_all_runtimes():
    for rt in RuntimeType:
        assert get_runtime_capability(rt).skill == SKILL_MODEL_MEDIATED


def test_lookup_accepts_enum_and_str_equivalently():
    assert get_runtime_capability(RuntimeType.HERMES) == get_runtime_capability("hermes")


def test_empty_and_unknown_are_unsupported():
    """AC3: 빈값/None/미등록 문자열 = 보수적 미지원."""
    for bad in (None, "", "  ".strip(), "unknown", "gpt-5", "CLAUDE-CODE"):
        cap = get_runtime_capability(bad)
        assert cap == UNSUPPORTED_CAPABILITY, f"{bad!r} 은 미지원이어야"
        assert cap.deterministic_command is False
        assert cap.command_endpoint_available is False


def test_supports_deterministic_command_helper():
    assert supports_deterministic_command("hermes") is True
    assert supports_deterministic_command("opencode") is False
    assert supports_deterministic_command(None) is False
    assert supports_deterministic_command("nope") is False


def test_capability_is_immutable():
    """frozen dataclass — 레지스트리 항목 변조 불가(SSOT 무결성)."""
    import dataclasses
    import pytest

    cap = get_runtime_capability("hermes")
    with pytest.raises(dataclasses.FrozenInstanceError):
        cap.deterministic_command = False  # type: ignore[misc]
