"""story #1995: `sprintable_send_chat_message`의 agent doc-mention 토큰 합성 — MCP 쪽 검증.

근본 원인: human이 채팅 UI에서 `#`으로 doc를 검색하면 chat-input.tsx의 applyEntity()가
`[title](entity:doc:id) ` 토큰을 삽입해 doc 링크/backlink가 동작한다. agent가
sprintable_send_chat_message로 보내는 raw content엔 이 토큰을 만들 방법이 없어 agent 발신
메시지의 doc 참조가 링크되지 않았다(선생님 "doc 링크 안 됨" 리포트 근본원인).

이 테스트는 (1) escape helper 단위 테스트(adversarial title — token-injection/forged-link
방지), (2) mentions→토큰 합성 통합 테스트(title 명시/생략 양쪽 경로 + 404 전파),
(3) mentions 생략 시 회귀 0(가장 중요), (4) type Literal["doc"] 외 값이 Pydantic 스키마
레벨에서 거부되는지를 검증한다.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from pydantic import ValidationError

from sprintable_mcp.tools import chat as chat_mod
from sprintable_mcp.tools.chat import (
    MentionRef,
    SendChatInput,
    escape_mention_title,
    send_chat_message,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── escape_mention_title ──────────────────────────────────────────────────────
def test_escape_mention_title_plain_string_passthrough():
    assert escape_mention_title("My Doc") == "My Doc"


def test_escape_mention_title_empty_string():
    assert escape_mention_title("") == ""


def test_escape_mention_title_adversarial_forged_link():
    """`x](https://evil.example)[y` — escape 없으면 markdown-link 토큰 구조를 깨고
    `[x](https://evil.example)[y](entity:doc:id) ` 처럼 임의 링크를 위조할 수 있다."""
    raw = "x](https://evil.example)[y"
    escaped = escape_mention_title(raw)
    assert escaped == r"x\]\(https://evil.example\)\[y"
    # 합성된 토큰 안에서 title 부분의 `]`/`(`/`)`가 전부 escape되어 링크 구조 경계가 title
    # 내부로 침범하지 않는다.
    token = f"[{escaped}](entity:doc:doc-1) "
    assert token == r"[x\]\(https://evil.example\)\[y](entity:doc:doc-1) "


def test_escape_mention_title_backslash():
    assert escape_mention_title("a\\b") == "a\\\\b"


def test_escape_mention_title_brackets_and_parens():
    assert escape_mention_title("[a](b)") == r"\[a\]\(b\)"


def test_escape_mention_title_collapses_newlines_to_single_space():
    assert escape_mention_title("line1\nline2") == "line1 line2"
    assert escape_mention_title("a\r\n\r\nb") == "a b"


# ── MentionRef schema validation ──────────────────────────────────────────────
def test_mention_ref_rejects_invalid_type():
    """type이 "doc" 외 값이면 Pydantic 스키마 레벨에서 거부(AC1) — 핸들러 코드 진입 전 차단."""
    with pytest.raises(ValidationError):
        MentionRef(type="story", id="s-1")


def test_send_chat_input_rejects_invalid_mention_type():
    with pytest.raises(ValidationError):
        SendChatInput(thread_id="conv-1", content="hi", mentions=[{"type": "task", "id": "t-1"}])


def test_mention_ref_accepts_doc_type():
    m = MentionRef(type="doc", id="d-1", title="My Doc")
    assert m.type == "doc"


# ── send_chat_message: token synthesis (title given) ─────────────────────────
@pytest.mark.anyio
async def test_send_chat_message_synthesizes_token_with_given_title():
    args = SendChatInput(
        thread_id="conv-1",
        content="see this",
        mentions=[{"type": "doc", "id": "11111111-1111-1111-1111-111111111111", "title": "My Doc"}],
    )
    with patch.object(chat_mod.client, "post", new=AsyncMock(return_value={"id": "m1"})) as m, \
         patch.object(chat_mod.client, "get", new=AsyncMock()) as g:
        result = await send_chat_message(args)
        g.assert_not_called()  # title 명시 → doc GET 조회 스킵
        _, kwargs = m.call_args
        assert kwargs["json"]["content"] == (
            "see this [My Doc](entity:doc:11111111-1111-1111-1111-111111111111) "
        )
        assert "Error" not in result[0].text


@pytest.mark.anyio
async def test_send_chat_message_synthesizes_token_multiple_mentions_no_double_space():
    args = SendChatInput(
        thread_id="conv-1",
        content="see these",
        mentions=[
            {"type": "doc", "id": "doc-a", "title": "Doc A"},
            {"type": "doc", "id": "doc-b", "title": "Doc B"},
        ],
    )
    with patch.object(chat_mod.client, "post", new=AsyncMock(return_value={"id": "m1"})) as m:
        await send_chat_message(args)
        _, kwargs = m.call_args
        assert kwargs["json"]["content"] == (
            "see these [Doc A](entity:doc:doc-a) [Doc B](entity:doc:doc-b) "
        )


@pytest.mark.anyio
async def test_send_chat_message_escapes_adversarial_given_title():
    args = SendChatInput(
        thread_id="conv-1",
        content="see this",
        mentions=[{"type": "doc", "id": "doc-1", "title": "x](https://evil.example)[y"}],
    )
    with patch.object(chat_mod.client, "post", new=AsyncMock(return_value={"id": "m1"})) as m:
        await send_chat_message(args)
        _, kwargs = m.call_args
        assert kwargs["json"]["content"] == (
            r"see this [x\]\(https://evil.example\)\[y](entity:doc:doc-1) "
        )


# ── send_chat_message: title omitted → fetched via client.get ────────────────
@pytest.mark.anyio
async def test_send_chat_message_fetches_title_when_omitted():
    args = SendChatInput(
        thread_id="conv-1",
        content="see this",
        mentions=[{"type": "doc", "id": "doc-1"}],
    )
    with patch.object(chat_mod.client, "get", new=AsyncMock(return_value={"id": "doc-1", "title": "Fetched Doc"})) as g, \
         patch.object(chat_mod.client, "post", new=AsyncMock(return_value={"id": "m1"})) as m:
        result = await send_chat_message(args)
        g.assert_awaited_once_with("/api/v2/docs/doc-1")
        _, kwargs = m.call_args
        assert kwargs["json"]["content"] == "see this [Fetched Doc](entity:doc:doc-1) "
        assert "Error" not in result[0].text


# ── send_chat_message: 404 on doc fetch propagates, no message POST ──────────
@pytest.mark.anyio
async def test_send_chat_message_mention_doc_not_found_errors_without_posting_message():
    args = SendChatInput(
        thread_id="conv-1",
        content="see this",
        mentions=[{"type": "doc", "id": "missing-doc"}],
    )

    with patch.object(chat_mod.client, "get", new=AsyncMock(side_effect=RuntimeError("404 Not Found"))) as g, \
         patch.object(chat_mod.client, "post", new=AsyncMock()) as m:
        result = await send_chat_message(args)
        g.assert_awaited_once_with("/api/v2/docs/missing-doc")
        m.assert_not_called()  # broken 토큰이 실린 반쪽 메시지가 저장되지 않는다
        assert result[0].text.startswith("Error")
        assert "404" in result[0].text


# ── mentions 생략 → 회귀 0 (가장 중요) ─────────────────────────────────────────
@pytest.mark.anyio
async def test_send_chat_message_mentions_omitted_byte_identical_to_current_behavior():
    """mentions 필드 자체를 안 넘긴 기존 호출자는 payload가 이 변경 前과 완전히 동일해야 한다."""
    args = SendChatInput(thread_id="conv-1", content="hi there")
    assert args.mentions is None
    with patch.object(chat_mod.client, "post", new=AsyncMock(return_value={"id": "m1"})) as m, \
         patch.object(chat_mod.client, "get", new=AsyncMock()) as g:
        result = await send_chat_message(args)
        g.assert_not_called()
        _, kwargs = m.call_args
        assert kwargs["json"] == {"content": "hi there"}
        assert "attachments" not in kwargs["json"]
        assert "mentions" not in kwargs["json"]
        assert "Error" not in result[0].text


@pytest.mark.anyio
async def test_send_chat_message_empty_mentions_list_byte_identical():
    """mentions=[] (falsy) 도 mentions=None과 동일하게 동작 — content 변조 없음."""
    args = SendChatInput(thread_id="conv-1", content="hi there", mentions=[])
    with patch.object(chat_mod.client, "post", new=AsyncMock(return_value={"id": "m1"})) as m:
        await send_chat_message(args)
        _, kwargs = m.call_args
        assert kwargs["json"]["content"] == "hi there"
