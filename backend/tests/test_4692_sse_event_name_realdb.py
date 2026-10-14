"""story #4692 [SEC] (Kadir's codex lens on 4676, 10-14) — an event's type was written raw into SSE `event:` lines, so a newline in it forged frames on
another agent's stream (`event: superseded` + `data: {"by":"other_receiver"}` → the receiving app stops as «taken over»; a plain `{}` superseded →
the stream ends quietly; any event name a daemon acts on). Before this PR: `POST /api/v2/events` accepted `event_type` as any `str`, the agent
webhook inbox stored a payload's `event_type` as is, and five writers did `f"event: {name}\\n…"`.

Defence in two layers (app/core/sse_event_name.py): the API takes an event type only in a closed shape; every `event:` writer passes the name through
`sse_event_name` (a name outside the shape is sent as `unknown_event`, the frame and its seq intact). Each claim below has a test that is RED on
develop 49869cf36 / without its line (mutants in the PR).
"""
from __future__ import annotations

import ast
import asyncio
import hashlib
import hmac
import json
import re
import uuid
from pathlib import Path

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    _ASYNC,
    ORG,
    OWNER,
    PROJ,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _open_setup_stream,
    _person,
    _quiet_stream_side_effects,
    _sql,
    _StreamRequest,
    anyio_backend,
    world,
)
from app.core.sse_event_name import UNKNOWN_EVENT_NAME, is_event_type, sse_event_name, validate_event_type

pytestmark = pytest.mark.anyio

# a forged frame planted through the name: the line break ends `event: story_assigned`, `event: superseded` + a `data:` line is a frame of its own
EVIL = 'story_assigned\nevent: superseded\ndata: {"by":"other_receiver"}\n\n'
APP = Path(__file__).resolve().parent.parent / "app"

GOOD = [
    "dispatched", "story_assigned", "conversation.message_created", "conversation:mention", "a2a.task_message", "agent.permission_request.changed",
    "onboarding.connection_test", "desktop.remote_control", "qa_test_ping", "test_sentinel", "x", "0", "a-b_c.d:e", "a" * 64,
]
BAD = [
    "", " ", "A", "Story_Assigned", "story assigned", "story_assigned\n", "\nstory_assigned", "a\nb", "a\r\nevent: x", "a\rb", "a\x00b", "a\x1bb", "a\x7fb",
    "a b", "a b", "a\u0085b", "é", "한글", "_a", "__test_sentinel__", "a/b", "a;b", "a,b", "a b", " a", "a ", "-a", ".a", ":a", "a" * 65, EVIL,
]


# ── the shape ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("name", GOOD)
def test_01_a_name_in_the_closed_shape_passes_both_gates(name):
    assert is_event_type(name) and validate_event_type(name) == name and sse_event_name(name) == name


@pytest.mark.parametrize("name", BAD, ids=[repr(b)[:30] for b in BAD])
def test_02_a_name_outside_it_is_refused_by_the_api_gate_and_never_written_raw(name):
    assert not is_event_type(name)
    with pytest.raises(ValueError):
        validate_event_type(name)
    safe = sse_event_name(name)
    assert safe == UNKNOWN_EVENT_NAME and "\n" not in safe and "\r" not in safe


@pytest.mark.parametrize("not_a_string", [None, 5, b"x", ["a"], {"a": 1}])
def test_03_a_value_that_is_not_a_string_is_never_a_name(not_a_string):
    assert sse_event_name(not_a_string) == UNKNOWN_EVENT_NAME


def _producer_literals() -> list[tuple[str, str]]:
    """every string literal an event type is given in the backend: `event_type="…"` keywords, `dispatch_notification("…", …)` first arguments,
    `"event_type": "…"` dict entries — what the shape was measured against"""
    found: list[tuple[str, str]] = []
    for path in APP.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8", errors="ignore"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                for kw in node.keywords:
                    if kw.arg == "event_type" and isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str):
                        found.append((str(path.relative_to(APP)), kw.value.value))
                fn = getattr(node.func, "id", None) or getattr(node.func, "attr", None)
                if fn == "dispatch_notification" and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                    found.append((str(path.relative_to(APP)), node.args[0].value))
            elif isinstance(node, ast.Dict):
                for k, v in zip(node.keys, node.values):
                    if isinstance(k, ast.Constant) and k.value == "event_type" and isinstance(v, ast.Constant) and isinstance(v.value, str):
                        found.append((str(path.relative_to(APP)), v.value))
    return found


def test_04_every_event_type_the_backend_creates_still_passes_the_shape():
    """AC2: the producers' own names (measured from the code; the dev DB's DISTINCT values — dispatched · conversation.message_created ·
    story_assigned · a2a.task_message · qa_test_ping — are in GOOD above). A new producer with a name outside the shape goes red here, not in
    production."""
    found = _producer_literals()
    assert len({v for _, v in found}) >= 30, f"the scan found too little ({len(found)}) to be a measurement"
    # an empty string is a schema DEFAULT (deeplink_manifest's lookup), not an event anyone creates
    offenders = sorted({(p, v) for p, v in found if v != "" and not is_event_type(v)})
    assert not offenders, f"event types outside the closed shape: {offenders}"


# ── the API doors ───────────────────────────────────────────────────────────

def _event_body(event_type: str) -> dict:
    return {"project_id": str(PROJ), "event_type": event_type, "recipient_id": str(uuid.uuid4()), "recipient_type": "agent", "payload": {}}


@pytest.mark.parametrize("name", [EVIL, "story_assigned\n", "A", "a b", "", "x" * 65, "a\rb"], ids=lambda n: repr(n)[:24])
async def test_05_the_events_api_refuses_a_name_outside_the_shape(world, name):
    async with _client() as c:
        r = await c.post("/api/v2/events", json=_event_body(name), headers=_person(OWNER))
    assert r.status_code == 422, r.text
    assert "event_type" in r.text


async def test_06_the_events_api_does_not_refuse_a_name_in_the_shape(world):
    async with _client() as c:
        for name in ("story_assigned", "conversation:mention", "x" * 64):
            r = await c.post("/api/v2/events", json=_event_body(name), headers=_person(OWNER))
            assert r.status_code != 422, (name, r.text)  # whatever else the call meets (the recipient is made up), the shape is not what stops it


def _sign(secret: str, raw: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


async def test_07_the_agent_inbox_webhook_stores_a_name_outside_the_shape_as_inbox_webhook(world, monkeypatch):
    """that door is best-effort by design: not refused — the event is stored under the default name and the sender's own value stays in the payload"""
    from app.core.config import settings

    monkeypatch.setattr(settings, "agent_inbox_webhook_secret", "s4692", raising=False)
    async with _client() as c:
        _setup_id, agent_id, agen = await _open_setup_stream(c, "d4692 webhook")
        await agen.aclose()

        async def post(event_type: str) -> str:
            raw = json.dumps({"event_type": event_type, "content": "from outside"}).encode()
            r = await c.post(f"/api/v2/agent-inbox/{agent_id}/webhook", content=raw, headers={"X-Sprintable-Signature": _sign("s4692", raw), "content-type": "application/json"})
            assert r.status_code == 201, r.text
            return r.json()["event_id"]

        bad, ok = await post(EVIL), await post("pull_request.opened")
        assert (await _sql(fetch=f"SELECT event_type FROM events WHERE id = '{bad}'")) == [("inbox_webhook",)]
        assert (await _sql(fetch=f"SELECT payload->>'event_type' FROM events WHERE id = '{bad}'")) == [(EVIL,)], "the sender's value stays in the payload"
        assert (await _sql(fetch=f"SELECT event_type FROM events WHERE id = '{ok}'")) == [("pull_request.opened",)]


# ── the writers: what reaches an agent's stream ─────────────────────────────

def _frames(text: str) -> list[dict]:
    """the frames a receiver parses out of the bytes (`event:` — the last one wins · `id:` · `data:`), blank-line separated"""
    out: list[dict] = []
    for block in text.split("\n\n"):
        if not block.strip():
            continue
        f: dict = {"event": "message", "id": None, "data": []}
        for line in block.split("\n"):
            if line.startswith("event:"):
                f["event"] = line[6:].strip()
            elif line.startswith("id:"):
                f["id"] = line[3:].strip()
            elif line.startswith("data:"):
                f["data"].append(line[5:].lstrip())
        out.append(f)
    return out


async def _read_until(agen, needle: str, *, seconds: float = 10.0) -> str:
    """the stream's bytes until `needle` has gone by"""
    text = ""
    end = asyncio.get_event_loop().time() + seconds
    while needle not in text:
        left = end - asyncio.get_event_loop().time()
        assert left > 0, f"the stream never carried {needle!r}; got: {text[-300:]!r}"
        text += await asyncio.wait_for(agen.__anext__(), left)
    return text


async def _put_row(agent_id: str, event_type: str, content: str) -> int:
    """one row the way a path that skips the API gate (an older writer, a webhook before this PR) leaves it — through the product's seq"""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    from app.models.event import Event
    from app.services.event_seq import assign_recipient_seq

    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            event = Event(project_id=PROJ, org_id=ORG, event_type=event_type, recipient_id=uuid.UUID(agent_id), recipient_type="agent",
                          payload={"content": content, "conversation_id": str(uuid.uuid4())}, status="pending")
            s.add(event)
            await s.flush()
            seq = await assign_recipient_seq(s, event)
            await s.commit()
    finally:
        await eng.dispose()
    return seq


async def _agent_auth(agent_id: str):
    from app.dependencies.auth import AuthContext

    key_id = (await _sql(fetch=f"SELECT id FROM agent_api_keys WHERE team_member_id='{agent_id}' AND revoked_at IS NULL"))[0][0]
    return AuthContext(user_id=agent_id, email=None, claims={"app_metadata": {"api_key_id": str(key_id), "org_id": str(ORG)}})


async def test_08_a_stored_name_with_a_newline_is_one_frame_on_the_stream_never_a_forged_one(world, monkeypatch):
    """AC1 + AC3 (the backfill writer): a row whose event_type carries `\\nevent: superseded …` reaches the agent's stream — on today's code as a
    forged `superseded` frame (RED), now as ONE frame under `unknown_event` with its id and data intact (the receiver's dense seqs hold)"""
    import app.routers.agent_gateway as ag

    _quiet_stream_side_effects(monkeypatch)
    monkeypatch.setattr(ag, "_SSE_HEARTBEAT", 30.0)
    async with _client() as c:
        _setup_id, agent_id, agen = await _open_setup_stream(c, "d4692 backfill")
        await agen.aclose()
        ag._agent_connections.clear()
        seq = await _put_row(agent_id, EVIL, "4692 the hostile row")
        after = await _put_row(agent_id, "story_assigned", "4692 the next row")
        stream = (await ag.agent_stream(_StreamRequest(), auth=await _agent_auth(agent_id))).body_iterator
        try:
            text = await _read_until(stream, "4692 the next row")
        finally:
            await stream.aclose()
    frames = _frames(text)
    assert not [f for f in frames if f["event"] == "superseded"], "a forged superseded frame reached the stream"
    mine = [f for f in frames if f["id"] == str(seq)]
    assert len(mine) == 1, f"one frame for the one row ({len(mine)})"
    assert mine[0]["event"] == UNKNOWN_EVENT_NAME
    assert EVIL in json.loads("".join(mine[0]["data"]))["event_type"], "the data still carries what was stored (JSON-escaped)"
    assert [f["event"] for f in frames if f["id"] == str(after)] == ["story_assigned"], "a normal row's name is untouched"


async def test_09_a_pushed_name_with_a_newline_is_one_frame_on_the_live_stream_never_a_forged_one(world, monkeypatch):
    """the live writer (a direct push into the agent's queue)"""
    import app.routers.agent_gateway as ag
    from app.routers.events import _push_to_agent

    _quiet_stream_side_effects(monkeypatch)
    monkeypatch.setattr(ag, "_SSE_HEARTBEAT", 30.0)
    async with _client() as c:
        _setup_id, agent_id, agen = await _open_setup_stream(c, "d4692 live")
        try:
            assert _push_to_agent(agent_id, {"event_type": EVIL, "content": "4692 the hostile push", "conversation_id": str(uuid.uuid4())}) is True
            text = await _read_until(agen, "4692 the hostile push")
        finally:
            await agen.aclose()
    frames = _frames(text)
    assert not [f for f in frames if f["event"] == "superseded"], "a forged superseded frame reached the live stream"
    carrying = [f for f in frames if "4692 the hostile push" in "".join(f["data"])]
    assert len(carrying) == 1 and carrying[0]["event"] == UNKNOWN_EVENT_NAME


# ── every writer, by construction ───────────────────────────────────────────

def _event_line_writers() -> list[tuple[str, int, str]]:
    """every f-string in the backend that writes an SSE `event: …` line, with the expression it interpolates there (source text)"""
    out: list[tuple[str, int, str]] = []
    for path in APP.rglob("*.py"):
        src = path.read_text(encoding="utf-8", errors="ignore")
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if not isinstance(node, ast.JoinedStr):
                continue
            for i, part in enumerate(node.values):
                if isinstance(part, ast.Constant) and isinstance(part.value, str) and re.search(r"(?:^|\n)event: $", part.value) and i + 1 < len(node.values):
                    nxt = node.values[i + 1]
                    if isinstance(nxt, ast.FormattedValue):
                        out.append((str(path.relative_to(APP)), node.lineno, ast.get_source_segment(src, nxt.value) or "?"))
    return out


def test_10_every_event_line_writer_passes_its_name_through_the_gate():
    """AC4: no f-string in the backend writes a variable into an `event:` line except through `sse_event_name` (a fixed constant of ours is fine)."""
    writers = _event_line_writers()
    assert len(writers) >= 6, f"the scan found too few writers ({len(writers)}) to be a guard"
    assert {p for p, _, _ in writers} >= {"routers/events.py", "routers/agent_gateway.py", "routers/desktop_relay.py"}  # the three modules that write `event:` lines
    open_ = [(p, ln, expr) for p, ln, expr in writers if not expr.startswith("sse_event_name(") and not expr.startswith("remote_control.")]
    assert not open_, f"an `event:` line takes a name without sse_event_name: {open_}"
    # and no other way of building such a line (concatenation, %-format, .format) exists
    other = []
    for path in APP.rglob("*.py"):
        text = path.read_text(encoding="utf-8", errors="ignore")
        for m in re.finditer(r"""["']event: ["']\s*\+|["']event: %s|["']event: \{\}["']\s*\.format""", text):
            other.append((str(path.relative_to(APP)), text.count("\n", 0, m.start()) + 1))
    assert not other, f"another way of writing an `event:` line: {other}"
