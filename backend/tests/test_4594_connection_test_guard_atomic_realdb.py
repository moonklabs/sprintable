"""story #4594 (QA 2선 on web PR 4975 · Qadir 2026-10-07 08:10Z) — the «one connection test waits» guard of #4582 is atomic.

The connect step read «is a test waiting?» and then wrote the test in two statements, with nothing between them that held
other connects of the same agent back (no FOR UPDATE · no unique · no upsert). Two connects at nearly the same moment (one
launcher started twice · a daemon restart overlapping the old stream) both read «none waiting» and both wrote one. Bounded
by the size of that first-connect burst (the next reconnect is held back by either row) — not the self-growing pile of
#4582, but two rows where the contract says one. Now the connect takes a transaction-scoped advisory lock keyed by the agent
before it reads (agent_verify.lock_connection_test_decision): the second connect waits until the first has committed, then
reads what the first wrote.

Pinned over a migrated PG (the 4424 harness · real setup + key + two real streams of the same agent at once;
get_verification_state · start_verification run for real). The race window is held open on purpose: a connect that has read
waits until the other connect has read too — OR is seen waiting on the advisory lock (pg_stat_activity) — so the verdict does
not depend on how the two coroutines happen to interleave. Without the lock both read «none» and both write (2 rows · RED);
with it the second connect never reads before the first's commit (1 row · and it read that row's seq).
"""
from __future__ import annotations

import asyncio

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    _addresses,
    _client,
    _code,
    _confirm,
    _dispose_global_engine_after_test,
    _exchange,
    _sql,
    _StreamRequest,
    anyio_backend,
    world,
)
from tests.test_4582_one_waiting_connection_test_realdb import _quiet_but_verify, _tests_for

pytestmark = pytest.mark.anyio


async def _advisory_waiters() -> int:
    """how many backends of this DB are blocked on an advisory lock right now — the second connect, when the guard is atomic"""
    rows = await _sql(fetch=(
        "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
        "AND wait_event_type = 'Lock' AND wait_event = 'advisory'"
    ))
    return rows[0][0]


def _hold_the_window_open(monkeypatch) -> list[dict]:
    """get_verification_state stays real, but a connect that has read waits for the other connect to read as well — or to be
    seen blocked on the lock before its read. Returns the states the connects read, in reading order."""
    import app.services.agent_verify as av

    real = av.get_verification_state
    seen: list[dict] = []
    both_read = asyncio.Event()

    async def read_then_wait(db, agent_id, **kw):
        state = await real(db, agent_id, **kw)
        seen.append(state)
        if len(seen) >= 2:
            both_read.set()
        while not both_read.is_set() and await _advisory_waiters() == 0:
            await asyncio.sleep(0.02)
        return state

    monkeypatch.setattr(av, "get_verification_state", read_then_wait)
    return seen


async def test_two_connects_at_once_start_one_connection_test(world, monkeypatch):
    import app.routers.agent_gateway as ag
    from app.core import shutdown as shutdown_module
    from app.dependencies.auth import AuthContext

    _quiet_but_verify(monkeypatch)
    monkeypatch.setattr(ag, "_SSE_HEARTBEAT", 30.0)
    seen = _hold_the_window_open(monkeypatch)
    async with _client() as c:
        code, verifier = await _code(c, "d4594 twice at once")
        setup_id = (await _confirm(c, code)).json()["setup_id"]
        agent_id = (await _exchange(c, code, verifier)).json()["agents"][0]["member_id"]
        key_id = (await _sql(fetch=(
            f"SELECT id FROM agent_api_keys WHERE desktop_setup_id='{setup_id}' AND team_member_id='{agent_id}'"
        )))[0][0]
        auth = AuthContext(user_id=agent_id, email=None, claims={"app_metadata": {"api_key_id": str(key_id), "org_id": str(ORG)}})
        assert await _tests_for(agent_id) == [], "a fresh agent: no test yet"

        async def connect() -> None:
            """one stream connect of this agent: the connect step runs before the first heartbeat is yielded"""
            agen = (await ag.agent_stream(_StreamRequest(), auth=auth)).body_iterator
            try:
                assert "event: heartbeat" in await agen.__anext__()
            finally:
                await agen.aclose()

        try:
            await asyncio.gather(connect(), connect())
        finally:
            ag._agent_connections.clear()
            shutdown_module.reset_shutdown_event()

    assert len(seen) == 2, f"both connects read the state: {seen}"
    tests = await _tests_for(agent_id)
    assert len(tests) == 1, f"two connects at once start one test, not one each: {tests}"
    # the second connect read what the first wrote (it waited for the first's commit) — not «none waiting» a second time
    assert [s["verify_seq"] for s in seen] == [None, tests[0]], f"the second read sees the first's test: {seen}"
