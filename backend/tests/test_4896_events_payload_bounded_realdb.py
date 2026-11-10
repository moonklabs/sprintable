"""story 4896 — the payload of `POST /api/v2/events` has a size bound (64 KiB serialized) and a depth bound (8 levels).

Before: the payload was free JSON of any size and depth (a 1,000,000-character value was a 201), stored for the recipient and sent on to the bell, the stream and the agent gateway. Reproduced first (the
over-bound cells were 201 on develop), then the public body model refuses them with 422 and a message that says the limit and the size received. What the server's own publisher writes does not pass through
this route and is not touched.

Real Postgres, real HTTP route.
"""
from __future__ import annotations

import json

import pytest
from sqlalchemy import text

from tests.test_4846_ac14_room_reads_realdb import _as
from tests.test_4846_org_chat_rooms_realdb import (  # noqa: F401 — fixtures used by name
    _REAL_DB_URL,
    _dispose_global_engine_after_test,
    _world,
)

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]

LIMIT = 64 * 1024
DEPTH = 8


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _body(w, payload):
    return {"project_id": str(w.p1), "event_type": "dispatched", "recipient_id": str(w.h_b), "recipient_type": "human", "payload": payload}


def _size(payload) -> int:
    return len(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def _padded(to_bytes: int, char: str = "x") -> dict:
    """a flat payload whose compact serialization is exactly `to_bytes` bytes long"""
    base = _size({"blob": ""})
    per = len(char.encode("utf-8"))
    assert (to_bytes - base) % per == 0
    p = {"blob": char * ((to_bytes - base) // per)}
    assert _size(p) == to_bytes
    return p


def _nested(levels: int) -> dict:
    """a payload nested `levels` levels deep (a flat dict is 1)"""
    p: object = "leaf"
    for _ in range(levels):
        p = {"k": p}
    return p  # type: ignore[return-value]


async def _count_events(Session) -> int:
    async with Session() as s:
        return (await s.execute(text("SELECT count(*) FROM events"))).scalar_one()


async def _post(Session, w, caller, payload):
    return await _as(Session, w, caller, "POST", "/api/v2/events", _body(w, payload))


@pytest.mark.parametrize("caller", ["participant", "agent_participant"])
async def test_the_size_bound_has_an_edge_exactly_at_the_limit_passes_one_byte_more_is_refused(caller):
    engine, Session, w = await _world()
    try:
        r = await _post(Session, w, caller, _padded(LIMIT - 40))   # a little under
        assert r.status_code == 201, r.text[:300]
        r = await _post(Session, w, caller, _padded(LIMIT))
        assert r.status_code == 201, "exactly at the limit is allowed"
        before = await _count_events(Session)
        r = await _post(Session, w, caller, _padded(LIMIT + 1))
        assert r.status_code == 422, r.text[:300]
        assert str(LIMIT + 1) in r.text and str(LIMIT) in r.text, "it says the size received and the limit"
        assert len(r.text) < 2000, "and it does not carry the payload back"
        assert await _count_events(Session) == before, "nothing was stored"
    finally:
        await engine.dispose()


async def test_the_size_is_counted_in_bytes_not_characters():
    engine, Session, w = await _world()
    try:
        r = await _post(Session, w, "participant", _padded(LIMIT - 2, "가"))   # 3 bytes a character: 21,841 characters, just under the limit in bytes
        assert r.status_code == 201, r.text[:300]
        r = await _post(Session, w, "participant", _padded(LIMIT + 1, "가"))   # 21,842 characters — far under 65,536 characters, over the limit in bytes
        assert r.status_code == 422, r.text[:300]
    finally:
        await engine.dispose()


async def test_the_size_that_was_a_201_on_develop_a_million_characters_is_refused():
    engine, Session, w = await _world()
    try:
        r = await _post(Session, w, "participant", {"blob": "x" * 1_000_000})
        assert r.status_code == 422, r.text[:300]
    finally:
        await engine.dispose()


async def test_the_depth_bound_has_an_edge_eight_levels_pass_nine_are_refused():
    engine, Session, w = await _world()
    try:
        r = await _post(Session, w, "participant", _nested(DEPTH))
        assert r.status_code == 201, r.text[:300]
        before = await _count_events(Session)
        r = await _post(Session, w, "participant", _nested(DEPTH + 1))
        assert r.status_code == 422, r.text[:300]
        assert f"{DEPTH + 1} levels" in r.text and f"limit is {DEPTH}" in r.text, "it says the depth received and the limit"
        assert await _count_events(Session) == before
        r = await _post(Session, w, "participant", {"list": [[[[[[[["leaf"]]]]]]]]})   # lists count as levels too: 1 + 8 = 9
        assert r.status_code == 422, r.text[:300]
        r = await _post(Session, w, "participant", {"list": [[[[[[["leaf"]]]]]]]})     # 1 + 7 = 8
        assert r.status_code == 201, r.text[:300]
    finally:
        await engine.dispose()


async def test_a_very_deep_body_is_a_422_not_a_server_error():
    engine, Session, w = await _world()
    try:
        r = await _post(Session, w, "participant", _nested(400))
        assert r.status_code == 422, r.status_code
    finally:
        await engine.dispose()


async def test_ordinary_payloads_and_the_empty_one_are_untouched():
    engine, Session, w = await _world()
    try:
        for payload in ({}, {"title": "t", "body": "b", "refs": {"story": {"id": "1", "name": "n"}}, "list": [1, 2, {"a": [3]}]}):
            r = await _post(Session, w, "participant", payload)
            assert r.status_code == 201, (payload, r.text[:300])
    finally:
        await engine.dispose()


@pytest.mark.parametrize("token", ["NaN", "Infinity", "-Infinity"])
async def test_non_finite_numbers_are_a_422_not_a_server_error_at_the_write(token):
    """the request parser takes the non-standard tokens NaN / Infinity; the stored JSON column does not"""
    from app.main import app
    from tests.test_1994_backlink_api_realdb import _client_for, _setup_app_human

    engine, Session, w = await _world()
    try:
        await _setup_app_human(app, Session, w.u_a, w.org)
        try:
            raw = ('{"project_id": "%s", "event_type": "dispatched", "recipient_id": "%s", "recipient_type": "human", "payload": {"x": %s}}' % (w.p1, w.h_b, token)).encode()
            async with _client_for(app) as c:
                r = await c.post("/api/v2/events", content=raw, headers={"content-type": "application/json"})
        finally:
            app.dependency_overrides.clear()
        assert r.status_code == 422, (r.status_code, r.text[:300])
        assert "NaN" in r.text
    finally:
        await engine.dispose()
