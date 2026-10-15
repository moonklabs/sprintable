"""story #4404 — end the worker session's transaction right before an external call.

The publication worker (cron publication-commands) and its sub-steps (insights, comments, ad spend, channel token refresh)
used to await provider HTTP — uploads of up to 900 s — with the session's transaction still open: idle in transaction on the
small worker pool (2 + 1), uncommitted claim rows that made a second publisher of the same key queue on its INSERT, and a row
lock on the insight snapshot during GA4 enrichment.

Duplicate publishing between workers does not rely on that open transaction: the command claim (`status=in_progress`) and the
provider-call marker are committed before the call (publication_command). Where a unique key is the guard
(channel_publications · ads_boost_runs), the row is committed as the claim first — the loser gets IntegrityError at once and
the existing in-progress handling, instead of waiting on the INSERT. Results are written after the call in a new short
transaction (autobegin).

COMMIT, never ROLLBACK: every session factory uses expire_on_commit=False, so the ORM objects the caller holds stay usable;
a rollback would expire them. Not for background_jobs handlers — their worker forbids a handler commit
(HandlerCommittedError); none of the call sites of this module runs there.
"""
from __future__ import annotations

import functools
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import TypeVar

from sqlalchemy.ext.asyncio import AsyncSession


T = TypeVar("T")


async def end_transaction_before_external_call(db: AsyncSession) -> None:
    """Commit the session's open transaction, if any, before an external call. Writes pending in it are committed too —
    call sites only reach here with writes that must stand whether or not the call succeeds (see the PR table)."""
    if db.in_transaction():
        await db.commit()


# Shared fetchers (insights · comments · ad spend) are also called from request handlers, where committing would change the
# request's atomicity (a flushed schedule row committed before the fetch). The worker loops opt in explicitly around their
# fetch; the helper below commits only inside that scope.
_WORKER_SCOPE: ContextVar[bool] = ContextVar("end_transaction_before_external_call_worker_scope", default=False)


@contextmanager
def worker_ends_transactions_before_external_calls() -> Iterator[None]:
    token = _WORKER_SCOPE.set(True)
    try:
        yield
    finally:
        _WORKER_SCOPE.reset(token)


async def end_transaction_before_external_call_in_worker(db: AsyncSession) -> None:
    """Same as end_transaction_before_external_call, only inside worker_ends_transactions_before_external_calls()."""
    if _WORKER_SCOPE.get():
        await end_transaction_before_external_call(db)


def in_worker_scope(fn: Callable[..., Awaitable[T]]) -> Callable[..., Awaitable[T]]:
    """Decorator for a worker entry point: its whole run is inside worker_ends_transactions_before_external_calls()."""

    @functools.wraps(fn)
    async def wrapper(*args, **kwargs) -> T:
        with worker_ends_transactions_before_external_calls():
            return await fn(*args, **kwargs)

    return wrapper
