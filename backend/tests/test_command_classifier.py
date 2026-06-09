"""E-CHAT-CMD S3: 슬래시 커맨드 판정 classifier 단위테스트 (AC1/AC2/AC3 케이스 커버)."""
import pytest

from app.services.command_classifier import (
    CommandCandidate,
    classify_command,
    dequote_literal,
    is_command,
)


# ── AC1: 커맨드 인식 (^/[a-zA-Z]) ──────────────────────────────────────────────
@pytest.mark.parametrize("text,name", [
    ("/cmd", "cmd"),
    ("/c", "c"),                 # 단일 영문자
    ("/CMD", "CMD"),             # 대문자
    ("/Deploy", "Deploy"),
    ("/cmd-sub", "cmd-sub"),     # 영문자 시작 후 비공백 허용
    ("/x123", "x123"),           # 영문자 시작이면 숫자 포함 가능
])
def test_recognized_as_command(text, name):
    cand = classify_command(text)
    assert cand is not None, f"{text!r} 은 커맨드여야"
    assert cand.name == name
    assert is_command(text) is True


# ── AC1: 비대상 ────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("text", [
    "/123",      # 숫자
    "/?",        # 기호
    "/!hi",      # 기호
    "/한글",      # 비-ASCII
    "/",         # 슬래시 단독
    "//",        # 슬래시 둘
    "hello",     # 슬래시 없음
    "hello /cmd",  # 슬래시가 맨 앞 아님
    "",          # 빈 문자열
    "   ",       # 공백만
])
def test_not_a_command(text):
    assert classify_command(text) is None, f"{text!r} 은 커맨드가 아니어야"
    assert is_command(text) is False


def test_none_input_is_not_command():
    assert classify_command(None) is None
    assert is_command(None) is False


# ── AC1: 이스케이프(리터럴) ────────────────────────────────────────────────────
@pytest.mark.parametrize("text", [
    " /cmd",     # 선행 공백 → 리터럴
    "\t/cmd",    # 선행 탭 → 리터럴
    "  /deploy", # 선행 공백 다수
    "//cmd",     # '//' → 리터럴
    "//deploy now",
])
def test_escaped_is_literal_not_command(text):
    assert classify_command(text) is None, f"{text!r} 은 이스케이프(리터럴)라 커맨드 아님"


def test_dequote_literal_collapses_leading_double_slash():
    # '//cmd' 리터럴 렌더 = '/cmd' (슬래시 1개 제거)
    assert dequote_literal("//cmd") == "/cmd"
    assert dequote_literal("//deploy now") == "/deploy now"
    # 선행 공백 이스케이프는 표시 의도 보존(그대로)
    assert dequote_literal(" /cmd") == " /cmd"
    # 일반 메시지는 무변형
    assert dequote_literal("hello") == "hello"
    assert dequote_literal("/cmd") == "/cmd"


# ── AC2: candidate metadata (원문·정규화·name·args) ────────────────────────────
def test_metadata_raw_normalized_name_args():
    cand = classify_command("/deploy app prod")
    assert cand == CommandCandidate(
        raw="/deploy app prod", normalized="/deploy app prod", name="deploy", args="app prod"
    )


def test_metadata_trailing_whitespace_normalized():
    cand = classify_command("/cmd   \n")
    assert cand is not None
    assert cand.raw == "/cmd   \n"        # 원문 보존
    assert cand.normalized == "/cmd"      # 트레일링 제거
    assert cand.name == "cmd"
    assert cand.args == ""


def test_metadata_no_args():
    cand = classify_command("/help")
    assert cand is not None and cand.name == "help" and cand.args == ""


def test_metadata_multiword_args_collapsed():
    cand = classify_command("/say   hello   world")
    assert cand is not None
    assert cand.name == "say"
    assert cand.args == "hello   world"   # 이름 뒤 인자(앞뒤 trim, 내부 보존)


def test_candidate_is_immutable():
    import dataclasses
    cand = classify_command("/cmd")
    assert cand is not None
    with pytest.raises(dataclasses.FrozenInstanceError):
        cand.name = "x"  # type: ignore[misc]
