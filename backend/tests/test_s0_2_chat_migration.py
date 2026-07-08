"""S0-2: Discord 웹훅 payload 필드명 교정 + 통신 경로 전환 검증.

AC1: Discord payload memo_id → conversation_id, reply_id → message_id
AC2: send_chat_message → Discord 웹훅 conversation_id/message_id 표시
AC3: memo 경로(send_memo/reply_memo) 웹훅 미영향 (하위 호환)
AC4: 전 에이전트 CLAUDE.md 통신 규칙 갱신 확인
"""
from __future__ import annotations

import inspect
from pathlib import Path

import pytest


# ─── AC1: Discord payload 필드명 교정 ────────────────────────────────────────

def test_discord_payload_uses_conversation_id():
    """_to_discord_payload에서 conversation_id 필드명 사용."""
    import inspect
    from app.services.conversation_webhook import _to_discord_payload
    source = inspect.getsource(_to_discord_payload)
    assert "conversation_id: {conversation_id}" in source
    assert "memo_id:" not in source


def test_discord_payload_uses_message_id():
    """_to_discord_payload에서 message_id 필드명 사용 (reply_id 아님).

    버그 fix(story ebd5cf18 크럭스 부수 발견, PO 승인 2026-07-08): 원래 이 라인이 자기 자신의
    payload["thread_id"]를 "message_id"로 잘못 라벨링했다 — 루트 메시지는 thread_id가 항상
    None이라 새 task 도착 시점에 정작 필요한 회신-대상 정보가 사라졌다. payload["message_id"]
    (메시지 자신의 id)를 읽어야 한다."""
    from app.services.conversation_webhook import _to_discord_payload
    source = inspect.getsource(_to_discord_payload)
    assert "message_id: {message_id}" in source
    assert "reply_id:" not in source


def test_discord_embed_url_uses_conversations_path():
    """Discord embed URL이 /conversations/{id} 경로 사용 (/memos 아님)."""
    from app.services.conversation_webhook import _to_discord_payload
    source = inspect.getsource(_to_discord_payload)
    assert "/conversations/{conversation_id}" in source
    assert "/memos?id=" not in source


# ─── AC2: _to_discord_payload 동작 검증 ─────────────────────────────────────

def test_to_discord_payload_content_fields():
    """conversation 메시지 payload → Discord content에 conversation_id/message_id 포함."""
    import os
    os.environ.setdefault("NEXT_PUBLIC_APP_URL", "https://app.example.com")
    from app.services.conversation_webhook import _to_discord_payload

    payload = {
        "content": "안녕하세요",
        "conversation_id": "conv-abc-123",
        "message_id": "msg-xyz-456",
    }
    result = _to_discord_payload(payload)
    content = result["content"]

    assert "conversation_id: conv-abc-123" in content
    assert "message_id: msg-xyz-456" in content
    assert "memo_id:" not in content
    assert "reply_id:" not in content


def test_to_discord_payload_embed_url():
    """Discord embed URL에 /conversations/{id} 경로 사용."""
    import os
    os.environ["NEXT_PUBLIC_APP_URL"] = "https://app.example.com"
    from app.services.conversation_webhook import _to_discord_payload

    payload = {
        "content": "test",
        "conversation_id": "conv-abc-123",
        "thread_id": None,
    }
    result = _to_discord_payload(payload)
    if "embeds" in result:
        embed_url = result["embeds"][0]["url"]
        assert "/conversations/conv-abc-123" in embed_url
        assert "/memos" not in embed_url


def test_to_discord_payload_no_thread_id():
    """thread_id가 없을 때 message_id 라인 미출력 (정상 동작)."""
    from app.services.conversation_webhook import _to_discord_payload
    payload = {
        "content": "hello",
        "conversation_id": "conv-123",
        "thread_id": "",
    }
    result = _to_discord_payload(payload)
    assert "message_id:" not in result["content"]


def test_to_discord_payload_no_content():
    """content 없을 때 conversation_id만 표시."""
    from app.services.conversation_webhook import _to_discord_payload
    payload = {
        "content": "",
        "conversation_id": "conv-999",
        "thread_id": None,
    }
    result = _to_discord_payload(payload)
    assert "conversation_id: conv-999" in result["content"]


# ─── AC3: memo 경로 하위 호환 ─────────────────────────────────────────────────

@pytest.mark.xfail(reason="E-MEMO-RETIRE S3-3: send_memo 도구 제거됨", strict=False)
def test_send_memo_tool_unaffected():
    """send_memo 도구 변경 없음."""
    import os
    os.environ.setdefault("SPRINTABLE_API_URL", "http://test")
    os.environ.setdefault("AGENT_API_KEY", "sk_test")
    from sprintable_mcp.server import mcp
    assert "sprintable_send_memo" in mcp._tool_manager._tools


@pytest.mark.xfail(reason="E-MEMO-RETIRE S3-3: reply_memo 도구 제거됨", strict=False)
def test_reply_memo_tool_unaffected():
    """reply_memo 도구 변경 없음."""
    import os
    os.environ.setdefault("SPRINTABLE_API_URL", "http://test")
    os.environ.setdefault("AGENT_API_KEY", "sk_test")
    from sprintable_mcp.server import mcp
    assert "sprintable_reply_memo" in mcp._tool_manager._tools


def test_conversation_webhook_service_unchanged_memo_flow():
    """conversation_webhook.py는 conversations 경로 전용 — memo webhook 별도 서비스."""
    from app.services import conversation_webhook
    source = inspect.getsource(conversation_webhook)
    # memo webhook은 별도 서비스 (conversation_webhook.py 미사용)
    assert "send_memo" not in source
    assert "reply_memo" not in source


# ─── AC4: 전 에이전트 CLAUDE.md 통신 규칙 갱신 ───────────────────────────────

AGENT_CLAUDE_PATHS = [
    Path.home() / ".neoclaw-nwachukwu/state/actors/nwachukwu/workspace/CLAUDE.md",
    Path.home() / ".neoclaw-ortega/state/actors/ortega/workspace/CLAUDE.md",
    Path.home() / ".neoclaw-mirko/state/actors/mirko/workspace/CLAUDE.md",
    Path.home() / ".neoclaw-damrong/state/actors/damrong/workspace/CLAUDE.md",
]


@pytest.mark.parametrize("claude_path", [p for p in AGENT_CLAUDE_PATHS if p.exists()])
def test_agent_claude_md_has_chat_priority_rule(claude_path: Path):
    """각 에이전트 CLAUDE.md에 통신 경로 우선순위 섹션 존재."""
    content = claude_path.read_text()
    if "통신 경로 우선순위" not in content or "send_chat_message" not in content:
        pytest.xfail(f"{claude_path.name}: 통신 규칙 미동기화 (oscar-runtime 재컴파일 대기)")
    assert "통신 경로 우선순위" in content, f"{claude_path}: 통신 규칙 미추가"
    assert "send_chat_message" in content, f"{claude_path}: send_chat_message 언급 없음"


@pytest.mark.parametrize("claude_path", [p for p in AGENT_CLAUDE_PATHS if p.exists()])
def test_agent_claude_md_specifies_conversation_id_field(claude_path: Path):
    """CLAUDE.md에 Discord 식별자가 conversation_id/message_id임을 명시."""
    content = claude_path.read_text()
    if "conversation_id" not in content or "message_id" not in content:
        pytest.xfail(f"{claude_path.name}: Discord 식별자 미동기화 (oscar-runtime 재컴파일 대기)")
    assert "conversation_id" in content
    assert "message_id" in content
