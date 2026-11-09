"""story #4867 — a small concurrency gate for work that is thrown away «fire and forget» and each piece of which takes a place of the REQUEST pool.

Why: prod 11-09 (story #4864). The request pool is 20 + 10. Three kinds of background work started one task per piece with no bound at all:
  · an org-wide event (presence · attention) → one `pg_notify` task per member → a 40-member org takes 30 of 30 places at the same instant;
  · every agent API request → one AU metering task (its own connection, an org-wide advisory lock);
  · every agent tool-call request → one tool-call recording task (its own connection).
On a healthy database each piece lasts a few ms, so it only shows as «27/30, 30/30 at age 0 s» in the pool watch; with places already stuck, or a reconnect storm that feeds itself
(a stream connects → presence → fan-out → pool full → streams fail → reconnect), it is the amplifier.

The gate does not drop anything and does not reorder it: a piece waits for its turn (asyncio.Semaphore is FIFO) and then runs exactly as before. At most `limit` pieces hold a pool
place at a time; the rest wait as a few bytes of coroutine, not as pool connections.

Shutdown: pieces waiting at a gate when the app stops would be cancelled by the 5-second drain (pg_pubsub.drain_background_tasks) and their writes lost — with a cap of 2 a backlog needs
longer than 5 s. So the lifespan calls `open_all()` the moment it starts stopping: every gate lets everything through at once (the pre-gate behaviour, bounded only by the pool),
including the pieces already waiting. `reset_all()` closes them again at start-up.

A semaphore belongs to ONE event loop (the app has one; the tests start a new loop per test), so one is made per running loop and it is held only by whoever is using it
(a WeakValueDictionary — a plain WeakKeyDictionary would keep every loop alive: a contended Semaphore refers to its loop, and the value refers to the key).
`limit <= 0` switches a gate off (no waiting at all).
"""
from __future__ import annotations

import asyncio
import contextlib
import weakref
from collections.abc import AsyncIterator, Callable

_OPEN_PERMITS = 10_000  # more than any backlog: «everything through at once»
_gates: "weakref.WeakSet[LoopGate]" = weakref.WeakSet()


class LoopGate:
    def __init__(self, limit: Callable[[], int]) -> None:
        self._limit = limit
        self._by_loop: "weakref.WeakValueDictionary[int, asyncio.Semaphore]" = weakref.WeakValueDictionary()
        self._open = False
        _gates.add(self)

    def _semaphore(self) -> "asyncio.Semaphore | None":
        if self._open:
            return None
        n = int(self._limit())
        if n <= 0:
            return None
        loop = asyncio.get_running_loop()
        key = id(loop)
        sem = self._by_loop.get(key)
        if sem is not None and getattr(sem, "_loop", None) not in (None, loop):
            sem = None  # an id() reused by a newer loop: that semaphore is not ours
        if sem is None:
            sem = asyncio.Semaphore(n)
            self._by_loop[key] = sem
        return sem

    @contextlib.asynccontextmanager
    async def slot(self) -> AsyncIterator[None]:
        sem = self._semaphore()
        if sem is None:
            yield
            return
        async with sem:
            yield

    def open(self) -> None:
        """Let everything through from now on, and wake whatever already waits on this loop's semaphore."""
        self._open = True
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        sem = self._by_loop.get(id(loop))
        if sem is not None:
            for _ in range(_OPEN_PERMITS):
                sem.release()

    def close(self) -> None:
        self._open = False


def open_all() -> None:
    for gate in list(_gates):
        gate.open()


def reset_all() -> None:
    for gate in list(_gates):
        gate.close()
