"""story #4867 — a small concurrency gate for work that is thrown away «fire and forget» and each piece of which takes a place of the REQUEST pool.

Why: prod 11-09 (story #4864). The request pool is 20 + 10. Two kinds of background work started one task per piece with no bound at all:
  · an org-wide event (presence · attention) → one `pg_notify` task per member → a 40-member org takes 30 of 30 places at the same instant;
  · every agent API request → one AU metering task (its own connection, an org-wide advisory lock) → a burst of requests is a burst of places.
On a healthy database each piece lasts a few ms, so it only shows as «27/30, 30/30 at age 0 s» in the pool watch; with places already stuck, or a reconnect storm that feeds itself
(a stream connects → presence → fan-out → pool full → streams fail → reconnect), it is the amplifier.

The gate does not drop anything and does not reorder it: a piece waits for its turn (asyncio.Semaphore is FIFO) and then runs exactly as before. At most `limit` pieces hold a pool
place at a time; the rest wait as a few bytes of coroutine, not as pool connections.

A semaphore belongs to ONE event loop (the app has one; the tests start a new loop per test), so one is made per running loop.
`limit <= 0` switches the gate off (no waiting at all).
"""
from __future__ import annotations

import asyncio
import contextlib
import weakref
from collections.abc import AsyncIterator, Callable


class LoopGate:
    def __init__(self, limit: Callable[[], int]) -> None:
        self._limit = limit
        self._by_loop: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = weakref.WeakKeyDictionary()

    def _semaphore(self) -> "asyncio.Semaphore | None":
        n = int(self._limit())
        if n <= 0:
            return None
        loop = asyncio.get_running_loop()
        sem = self._by_loop.get(loop)
        if sem is None:
            sem = asyncio.Semaphore(n)
            self._by_loop[loop] = sem
        return sem

    @contextlib.asynccontextmanager
    async def slot(self) -> AsyncIterator[None]:
        sem = self._semaphore()
        if sem is None:
            yield
            return
        async with sem:
            yield
