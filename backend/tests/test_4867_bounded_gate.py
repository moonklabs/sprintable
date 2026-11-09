"""story #4867 — the concurrency gate (app/core/bounded_gate.py), without a database: these tests must run — and fail when the gate is removed — on every machine (codex: the gate tests lived
in a file that skips itself when no real Postgres is configured)."""
from __future__ import annotations

import asyncio
import gc
import weakref

import pytest

from app.core import bounded_gate
from app.core.bounded_gate import LoopGate


@pytest.fixture(autouse=True)
def _gates_closed():
    bounded_gate.reset_all()
    yield
    bounded_gate.reset_all()


async def _run_pieces(gate: LoopGate, n: int = 12, hold: float = 0.01) -> int:
    active, peak = 0, 0

    async def piece():
        nonlocal active, peak
        async with gate.slot():
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(hold)
            active -= 1

    await asyncio.gather(*[piece() for _ in range(n)])
    return peak


def test_the_gate_limits_in_every_event_loop_it_meets():
    """One semaphore per loop: a single global semaphore binds to the first loop that contends and breaks (or ignores the limit) in the second — so contend in TWO loops."""
    gate = LoopGate(lambda: 2)
    assert asyncio.run(_run_pieces(gate)) == 2
    assert asyncio.run(_run_pieces(gate)) == 2


def test_two_loops_get_two_different_semaphores():
    gate = LoopGate(lambda: 2)
    seen = []
    loops = [asyncio.new_event_loop(), asyncio.new_event_loop()]
    try:
        for loop in loops:

            async def grab():
                sem = gate._semaphore()
                seen.append(sem)
                async with gate.slot():  # keep it in use so it stays alive while the other loop asks
                    return None

            loop.run_until_complete(grab())
    finally:
        for loop in loops:
            loop.close()
    assert len(seen) == 2 and seen[0] is not seen[1]


def test_zero_switches_the_gate_off():
    assert asyncio.run(_run_pieces(LoopGate(lambda: 0))) == 12


def test_the_gate_does_not_keep_a_finished_event_loop_alive():
    """codex: a contended Semaphore refers to its loop; if the gate keeps it under a weak KEY, the loop can never be collected — a pytest run (a loop per test) piles them up."""
    gate = LoopGate(lambda: 1)
    loop = asyncio.new_event_loop()
    loop.run_until_complete(_run_pieces(gate, n=4, hold=0.001))  # contended: the semaphore now refers to the loop
    loop.close()
    ref = weakref.ref(loop)
    del loop
    gc.collect()
    assert ref() is None, "the gate keeps a finished event loop alive"
    assert len(gate._by_loop) == 0


def test_open_all_lets_everything_through_including_what_already_waits():
    """Shutdown (codex): pieces waiting at a gate would be cancelled by the 5-second drain and their writes lost. open_all() must wake them and let new ones pass at once."""
    gate = LoopGate(lambda: 1)

    async def scenario():
        release = asyncio.Event()
        active, peak = 0, 0

        async def piece():
            nonlocal active, peak
            async with gate.slot():
                active += 1
                peak = max(peak, active)
                await release.wait()
                active -= 1

        tasks = [asyncio.create_task(piece()) for _ in range(6)]
        await asyncio.sleep(0.05)
        assert peak == 1, "while closed only one piece runs"
        bounded_gate.open_all()
        await asyncio.sleep(0.05)
        assert peak == 6, f"after open_all every waiting piece must run at once (saw {peak})"
        late = asyncio.create_task(piece())  # a piece that arrives after the gate was opened passes at once as well
        await asyncio.sleep(0.05)
        assert peak == 7
        release.set()
        await asyncio.gather(*tasks, late)

    asyncio.run(scenario())


def test_open_all_wakes_a_backlog_bigger_than_any_fixed_number_of_permits():
    """codex: a fixed 10 000 permits leave the tail of a bigger backlog waiting at the gate, to be cancelled by the 5-second drain. One holder blocks the gate, 10 050 pieces queue behind it."""
    gate = LoopGate(lambda: 1)
    backlog = 10_050

    async def scenario():
        hold = asyncio.Event()
        entered = 0

        async def holder():
            async with gate.slot():
                await hold.wait()

        async def piece():
            nonlocal entered
            async with gate.slot():
                entered += 1
                await hold.wait()  # slow database work: a piece that finishes at once would pass the turn on by its own release and hide the shortfall

        h = asyncio.create_task(holder())
        await asyncio.sleep(0.01)
        tasks = [asyncio.create_task(piece()) for _ in range(backlog)]
        await asyncio.sleep(0.3)
        assert entered == 0, "the holder keeps the gate shut: nobody enters yet"
        bounded_gate.open_all()
        await asyncio.sleep(0.5)
        assert entered == backlog, f"{backlog - entered} pieces were left waiting at the opened gate (all of them are blocked in slow work, none releases)"
        hold.set()
        await asyncio.wait_for(asyncio.gather(h, *tasks), timeout=10)

    asyncio.run(scenario())


def test_reset_all_closes_a_gate_that_was_opened_inside_a_live_loop():
    """codex: open_all() outside a running loop touches no semaphore, so the old test never saw a REAL opened semaphore come back. Open it inside the loop that uses it
    (its permits are inflated), reset, and the same loop must be held to `limit` again."""
    gate = LoopGate(lambda: 2)

    async def scenario():
        await _run_pieces(gate, n=5, hold=0.001)  # the loop's semaphore exists and has contended
        in_use = gate._semaphore()  # the gate holds its semaphore only weakly: something in use keeps it alive across the reset, as a long piece would
        assert in_use is not None
        bounded_gate.open_all()  # inflates the live semaphore
        assert await _run_pieces(gate) == 12  # open: everything at once
        bounded_gate.reset_all()
        peak = await _run_pieces(gate)
        assert in_use is not None  # still referenced up to here
        return peak

    assert asyncio.run(scenario()) == 2


def test_reset_all_closes_the_gates_again():
    gate = LoopGate(lambda: 1)
    bounded_gate.open_all()
    assert asyncio.run(_run_pieces(gate)) == 12  # open: everything at once
    bounded_gate.reset_all()
    assert asyncio.run(_run_pieces(gate)) == 1


def _spy_on(monkeypatch, gate, events: list):
    """Replace a production gate's slot() with one that writes down when a piece gets in and out — the work between the two is what the gate is for."""
    import contextlib

    @contextlib.asynccontextmanager
    async def slot():
        events.append("gate-in")
        try:
            yield
        finally:
            events.append("gate-out")

    monkeypatch.setattr(gate, "slot", slot)


def _assert_work_is_inside_the_gate(events: list):
    assert events[0] == "gate-in" and events[-1] == "gate-out", events
    assert "work" in events[1:-1], f"the database work must run INSIDE the gate: {events}"


@pytest.mark.anyio
async def test_pg_notify_takes_its_pool_place_inside_the_gate(monkeypatch):
    """The wiring without a database (codex: every production-wrapper test was skipped when no Postgres is configured): delete the `_notify_gate.slot()` and this fails."""
    import contextlib

    from app.services import pg_pubsub

    events: list = []
    _spy_on(monkeypatch, pg_pubsub._notify_gate, events)

    class FakeSession:
        async def execute(self, *a, **k):
            events.append("work")

        async def commit(self):
            events.append("commit")

    @contextlib.asynccontextmanager
    async def fake_factory():
        events.append("session-open")
        yield FakeSession()
        events.append("session-close")

    monkeypatch.setattr("app.core.database.async_session_factory", fake_factory)
    await pg_pubsub.pg_notify("org", "00000000-0000-0000-0000-000000000001", "presence", {"x": 1})
    _assert_work_is_inside_the_gate(events)
    assert events.index("session-open") > events.index("gate-in") and events.index("session-close") < events.index("gate-out"), events


@pytest.mark.anyio
async def test_au_metering_writes_inside_the_gate(monkeypatch):
    import uuid

    from app.services import au_metering

    events: list = []
    _spy_on(monkeypatch, au_metering._au_gate, events)

    async def fake_record(org_id, delta):
        events.append("work")

    monkeypatch.setattr(au_metering, "record_au_usage", fake_record)
    await au_metering._record_au_usage_safe(uuid.uuid4(), 3)
    _assert_work_is_inside_the_gate(events)


@pytest.mark.anyio
async def test_tool_call_recording_writes_inside_the_gate(monkeypatch):
    import contextlib

    from app.services import tool_call_recording

    events: list = []
    _spy_on(monkeypatch, tool_call_recording._recording_gate, events)

    class FakeSession:
        def begin(self):
            @contextlib.asynccontextmanager
            async def tx():
                yield

            return tx()

    @contextlib.asynccontextmanager
    async def fake_factory():
        yield FakeSession()

    async def fake_insert(session, **kwargs):
        events.append("work")

    monkeypatch.setattr("app.core.database.async_session_factory", fake_factory)
    monkeypatch.setattr(tool_call_recording, "attribute_and_insert", fake_insert)
    await tool_call_recording._record_tool_call_safe(agent_id="a1")
    _assert_work_is_inside_the_gate(events)


def test_the_defaults_are_the_agreed_gates():
    from app.core.config import Settings

    assert Settings.model_fields["pg_notify_max_concurrent"].default == 4
    assert Settings.model_fields["au_metering_max_concurrent"].default == 2
    assert Settings.model_fields["tool_call_recording_max_concurrent"].default == 2


@pytest.mark.anyio
async def test_the_lifespan_resets_the_gates_at_start_and_opens_them_when_it_stops(monkeypatch):
    """The wiring: the real lifespan (fake engine, quiet listener) must call reset_all() on the way in and open_all() as soon as it starts stopping — deleting either call keeps the unit tests green."""
    from unittest.mock import AsyncMock, MagicMock

    from app.main import lifespan

    fake_engine = MagicMock()
    fake_engine.dispose = AsyncMock()
    monkeypatch.setattr("app.core.database.engine", fake_engine)

    async def quiet_listen():
        await asyncio.Event().wait()

    monkeypatch.setattr("app.services.pg_pubsub.listen_loop", quiet_listen)
    calls: list[str] = []
    monkeypatch.setattr(bounded_gate, "reset_all", lambda: calls.append("reset"))
    monkeypatch.setattr(bounded_gate, "open_all", lambda: calls.append("open"))
    async with lifespan(MagicMock()):
        assert calls == ["reset"], calls
    assert calls == ["reset", "open"], calls


@pytest.fixture
def anyio_backend():
    return "asyncio"
