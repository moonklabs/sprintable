"""story #4605 (Kadir 383 QA · PO 20:5xZ): a chat message's content has an upper bound — MESSAGE_CONTENT_MAX_BYTES in UTF-8 bytes,
under the desktop daemon's inbox SSE frame limit (1 MiB). It is checked once, on ConversationMessage.content, so every way a message
is written (the API's send · MCP send_chat_message on it · ws chat · a2a · the Slack/Teams bridge · the channel route · the
daemon/system writers) meets it; the API answers 422 `message_too_long`.

These cases need no database: the bound itself (± 1 byte · a multi-byte character across the line · assignment), the API envelope,
the a2a JSON-RPC envelope, and a guard that no code writes conversation_messages.content around the model (a bulk insert/update or
raw SQL would skip the check).
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from starlette.requests import Request

from app.models.conversation import MESSAGE_CONTENT_MAX_BYTES, ConversationMessage, MessageContentTooLong

LIMIT = MESSAGE_CONTENT_MAX_BYTES


def test_the_bound_is_256_kib_well_under_the_daemon_frame_limit():
    assert LIMIT == 256 * 1024
    assert LIMIT * 3 < 1024 * 1024  # room for the event envelope, escaping and the stream's own framing


@pytest.mark.parametrize("content", ["a" * LIMIT, "가" * (LIMIT // 3), "", "hello"], ids=["ascii-at-limit", "hangul-under", "empty", "short"])
def test_at_or_under_the_bound_a_message_is_built(content):
    assert ConversationMessage(content=content).content == content


@pytest.mark.parametrize(
    ("content", "got"),
    [
        ("a" * (LIMIT + 1), LIMIT + 1),  # one byte over
        ("가" * (LIMIT // 3 + 1), (LIMIT // 3 + 1) * 3),  # counted in bytes: one more 3-byte character crosses it
        ("a" * (LIMIT - 1) + "가", LIMIT + 2),  # the last character straddles the line
    ],
    ids=["ascii-plus-1", "hangul-plus-1-char", "straddling-char"],
)
def test_over_the_bound_a_message_is_refused_with_what_came(content, got):
    with pytest.raises(MessageContentTooLong) as e:
        ConversationMessage(content=content)
    assert (e.value.got, e.value.limit) == (got, LIMIT)


def test_an_assignment_meets_the_same_bound():
    msg = ConversationMessage(content="short")
    with pytest.raises(MessageContentTooLong):
        msg.content = "a" * (LIMIT + 1)
    msg.content = ""  # the delete route's scrub stays allowed
    assert msg.content == ""


def _request(path: str) -> Request:
    return Request({"type": "http", "method": "POST", "path": path, "headers": [], "query_string": b"", "app": None})


@pytest.mark.anyio
async def test_the_api_answers_422_message_too_long_with_the_limit_and_what_came():
    from app.main import message_too_long_handler

    resp = await message_too_long_handler(_request("/api/v2/conversations/x/messages"), MessageContentTooLong(LIMIT + 1))
    assert resp.status_code == 422
    body = json.loads(resp.body)
    assert body["error"]["code"] == "message_too_long"
    assert (body["error"]["limit"], body["error"]["got"]) == (LIMIT, LIMIT + 1)
    assert str(LIMIT) in body["error"]["message"]


@pytest.mark.anyio
async def test_the_a2a_rpc_route_gets_a_json_rpc_error_with_readable_words():
    from app.main import message_too_long_handler

    resp = await message_too_long_handler(
        _request("/api/v2/a2a/members/00000000-0000-0000-0000-000000000001/rpc"), MessageContentTooLong(LIMIT + 7),
    )
    body = json.loads(resp.body)
    assert "error" in body and "message_too_long" in body["error"]["message"]
    assert "{" not in body["error"]["message"], "never a Python dict printed into the message"


@pytest.mark.anyio
async def test_ws_chat_refuses_that_one_message_with_its_own_frame_and_keeps_the_socket():
    """ws chat: a message over the bound gets an error frame (the API's 422 in this socket's words) — the socket stays, the next
    message is kept. Before, the exception left the loop and the connection dropped."""
    import uuid
    from datetime import datetime, timezone
    from unittest import mock

    from fastapi import WebSocketDisconnect

    from app.routers import ws_chat

    agent_id = uuid.uuid4()
    caller = mock.Mock(id=uuid.uuid4(), org_id=uuid.uuid4())
    agent = mock.Mock(org_id=caller.org_id, project_id=uuid.uuid4())
    saved: list[str] = []

    class _Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def execute(self, *_a, **_k):
            return mock.Mock(scalar_one_or_none=lambda: agent)

        def add(self, msg):
            saved.append(msg.content)

        async def commit(self):
            pass

        async def refresh(self, msg):
            msg.id, msg.created_at = uuid.uuid4(), datetime.now(timezone.utc)

    class _Socket:
        def __init__(self, incoming):
            self.incoming, self.sent, self.closed = list(incoming), [], None

        async def accept(self):
            pass

        async def receive_text(self):
            if not self.incoming:
                raise WebSocketDisconnect()
            return self.incoming.pop(0)

        async def send_text(self, t):
            self.sent.append(t)

        async def close(self, code=1000, reason=None):
            self.closed = code

    ws = _Socket([json.dumps({"content": "a" * (LIMIT + 1)}), json.dumps({"content": "kept"})])
    with mock.patch.object(ws_chat, "_authenticate", mock.AsyncMock(return_value=caller)), \
            mock.patch.object(ws_chat, "async_session_factory", lambda: _Session()), \
            mock.patch.object(ws_chat, "_get_or_create_conversation", mock.AsyncMock(return_value=uuid.uuid4())), \
            mock.patch.object(ws_chat, "resolve_member_display_name", mock.AsyncMock(return_value="P")), \
            mock.patch.object(ws_chat, "_api_key_id", mock.AsyncMock(return_value=None)), \
            mock.patch.object(ws_chat, "_broadcast", mock.AsyncMock()):
        await ws_chat.ws_chat_hub(ws, agent_id, api_key="k", token=None)
    assert ws.closed is None, "the socket was not closed for it"
    assert json.loads(ws.sent[0]) == {"error": {"code": "message_too_long", "limit": LIMIT, "got": LIMIT + 1}}
    assert saved == ["kept"]  # mutant: the try/except gone → the exception leaves the loop, «kept» never saved → RED


def test_no_code_writes_message_content_around_the_model():
    """A bulk insert/update or raw SQL on conversation_messages would skip the model's check — none may set content. (A bulk
    update that only bumps reply_count is fine; this guard reads each such statement's own .values(...) for `content`.)"""
    app_dir = Path(__file__).resolve().parents[1] / "app"
    hits: list[str] = []
    for path in app_dir.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        rel = path.relative_to(app_dir.parent)
        if re.search(r"insert\(\s*ConversationMessage\s*\)", text):
            hits.append(f"{rel}: insert(ConversationMessage)")
        if re.search(r"INSERT\s+INTO\s+conversation_messages", text, re.IGNORECASE):
            hits.append(f"{rel}: raw INSERT INTO conversation_messages")
        if re.search(r"UPDATE\s+conversation_messages\s+SET[^;]*\bcontent\s*=", text, re.IGNORECASE):
            hits.append(f"{rel}: raw UPDATE … content")
        for m in re.finditer(r"update\(\s*ConversationMessage\s*\)(.*?)\)\s*\)", text, re.DOTALL):
            if re.search(r"\bcontent\s*=", m.group(1)):
                hits.append(f"{rel}: update(ConversationMessage).values(content=…)")
    assert hits == []


def test_the_guard_sees_what_it_guards():
    """positive control for the guard above: each shape it refuses is matched on a sample"""
    samples = [
        "await db.execute(insert(ConversationMessage).values(content=x))",
        "await db.execute(text('INSERT INTO conversation_messages (content) VALUES (:c)'))",
        "UPDATE conversation_messages SET content = :c WHERE id = :i",
    ]
    assert re.search(r"insert\(\s*ConversationMessage\s*\)", samples[0])
    assert re.search(r"INSERT\s+INTO\s+conversation_messages", samples[1], re.IGNORECASE)
    assert re.search(r"UPDATE\s+conversation_messages\s+SET[^;]*\bcontent\s*=", samples[2], re.IGNORECASE)
    upd = "update(ConversationMessage)\n  .where(x)\n  .values(content='y')\n)"
    m = re.search(r"update\(\s*ConversationMessage\s*\)(.*?)\)\s*\)", upd, re.DOTALL)
    assert m and re.search(r"\bcontent\s*=", m.group(1))
