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


def test_the_bound_is_128_kib_and_a_message_frame_fits_the_stream_bound_whole():
    from app.routers.agent_gateway import AGENT_FRAME_MAX_BYTES

    assert LIMIT == 128 * 1024
    # PO 21:03Z (가): a message at the bound goes down the agent stream whole — twice (payload · top-level), each with up to 24k
    # characters of attachment text appended (attachment_context · 3 bytes each at most), and the envelope — under the stream's frame
    # bound, itself half the daemon's 1 MiB
    assert 2 * (LIMIT + 3 * 24_000) + 16 * 1024 < AGENT_FRAME_MAX_BYTES <= 512 * 1024


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


# ── PO 21:03Z (가): the agent stream's frame bound — what is not a message (a dispatch's doc · an event payload · event_context) ──

def _gw():
    from app.routers import agent_gateway

    return agent_gateway


def test_a_frame_is_written_without_u_escapes_hangul_three_bytes_not_six():
    gw = _gw()
    data = {"event_id": "e1", "content": "안녕 👋", "payload": {"content": "안녕 👋"}}
    out = gw._frame_data(data)
    assert out == json.dumps(data, ensure_ascii=False) and "\\u" not in out  # mutant: ensure_ascii left on → RED
    assert json.loads(out) == data


def test_a_message_at_the_bound_goes_down_whole():
    gw = _gw()
    body = "가" * (LIMIT // 3)
    out = gw._frame_data({"event_id": "e1", "content": body, "payload": {"content": body, "audience": None}, "is_backfill": False})
    assert "truncated" not in json.loads(out) and json.loads(out)["content"] == body


def test_a_frame_past_the_bound_has_its_long_strings_cut_and_says_so_its_ids_kept():
    gw = _gw()
    doc = "문서 본문 " * 200_000  # ~2.6 MB — a dispatch carrying a whole doc (agent_dispatch · no bound of its own)
    data = {"event_id": "e9", "event_type": "dispatched", "recipient_seq": 41, "content": doc,
            "payload": {"content": doc, "context_pack": doc, "story_id": "s-1"}, "is_backfill": False}
    out = gw._frame_data(data)
    assert len(out.encode("utf-8")) <= gw.AGENT_FRAME_MAX_BYTES  # mutant: no bound (plain json.dumps) → RED
    frame = json.loads(out)
    assert frame["truncated"] is True
    assert (frame["event_id"], frame["event_type"], frame["recipient_seq"], frame["payload"]["story_id"]) == ("e9", "dispatched", 41, "s-1")
    for s in (frame["content"], frame["payload"]["content"], frame["payload"]["context_pack"]):
        assert s.startswith("문서 본문 ") and s.endswith(gw.FRAME_CUT_NOTE)
        assert len(s.encode("utf-8")) <= gw._FRAME_STR_KEEP_BYTES + len(gw.FRAME_CUT_NOTE.encode("utf-8"))


def test_a_frame_of_many_short_strings_falls_back_to_its_own_short_fields():
    gw = _gw()
    data = {"event_id": "e7", "recipient_seq": 3, "event_type": "custom", "payload": {"rows": ["값" * 100] * 50_000}}
    out = gw._frame_data(data)
    assert len(out.encode("utf-8")) <= gw.AGENT_FRAME_MAX_BYTES
    assert json.loads(out) == {"event_id": "e7", "recipient_seq": 3, "event_type": "custom", "truncated": True}


def test_a_lone_surrogate_in_a_pushed_dict_keeps_the_escaped_form():
    gw = _gw()
    out = gw._frame_data({"event_id": "e2", "content": "a\ud800b"})
    out.encode("utf-8")  # writable
    assert "\\ud800" in out


def test_every_event_frame_of_the_agent_stream_goes_through_the_bound():
    """both places a row or a push becomes a frame call _frame_data — a frame written with json.dumps beside it skips the bound"""
    src = Path(_gw().__file__).read_text(encoding="utf-8")
    frames = re.findall(r"_sse = (\w+)\(", src)
    assert frames == ["_frame_data", "_frame_data"], frames  # mutant: either site back on json.dumps → RED
    assert re.findall(r'yield f"event: \{[^}]+\}(?:\\nid: \{gseq\})?\\ndata: \{(\w+)\}', src) == ["_sse", "_sse"]
