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


def test_reset_all_closes_the_gates_again():
    gate = LoopGate(lambda: 1)
    bounded_gate.open_all()
    assert asyncio.run(_run_pieces(gate)) == 12  # open: everything at once
    bounded_gate.reset_all()
    assert asyncio.run(_run_pieces(gate)) == 1


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
