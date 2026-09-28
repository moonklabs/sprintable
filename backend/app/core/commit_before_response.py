"""story #4389 — a write request's DB commit happens **before** its response headers are sent.

Before: `get_db` committed in its teardown (after `yield`). With FastAPI 0.136 the default dependency scope ("request") runs that
teardown **after the response has been sent**, so a client could get 201 for a row that was not committed yet. Creating something
and immediately referencing it (e.g. a folder, then a doc under it) then failed now and then with 404: 1/300 and 1/1000 back-to-back
pairs on a real uvicorn, 0/300 with a 20ms gap. A commit that failed at teardown was also hidden behind the success response already
sent.

How:
- `get_db` / `get_worker_db` register their session in a per-request holder (a ContextVar this middleware creates for each HTTP
  request). Outside a request (scripts, tests calling the dependency directly) there is no holder and nothing changes.
- A session is marked as having written by SQLAlchemy events: `after_flush` (ORM changes) and `do_orm_execute` for INSERT / UPDATE /
  DELETE statements, Core or `text()`. Pending new / dirty / deleted objects also count.
- `CommitBeforeResponseMiddleware` intercepts the first `http.response.start` and commits every registered session that wrote, then
  lets the headers go. Read-only requests are not touched (no extra COMMIT round trip in the user's wait).
  An exception raised in the endpoint rolls `get_db`'s session back **before** the error response is sent (measured on FastAPI 0.136),
  so there is nothing left to commit for it; a route that *returns* an error after writing is committed like any other response
  (as before, only earlier).
- If that commit fails, the session is rolled back and flagged, and the failure goes through the app's own unhandled-exception
  handler — the same response as when an endpoint raises: an `unhandled_error_events` audit row, the REST 500 envelope, and on the
  A2A `/rpc` path a JSON-RPC error (-32603 · the request's id · retryable). Headers were not sent yet, so the client gets that
  instead of the success. `get_db`'s teardown sees the flag and rolls back instead of committing again.
- The «wrote» mark is cleared when the outermost transaction ends (commit or rollback), so a route that commits by itself (e.g.
  cron.py) gets no second, empty COMMIT before its headers. A SAVEPOINT ending does not clear it.
- Writes made **after** the response (BackgroundTasks on the request session, bodies of streaming responses) still commit in
  `get_db`'s teardown, as before — they are listed in the PR (AC2).

Known limits (also in the PR):
- Several sessions in one request are committed one after another, not atomically (the old teardown commit was the same).
- When a streaming response is replaced by the failure response, its original body generator is not consumed further; that only
  happens when the commit failed.
- `text()` DML is recognised by a regex. A shape it misses commits at teardown, as before. Writes issued directly on
  `session.connection()` bypass `do_orm_execute` the same way; nothing in app/ does that today (see the PR table).
"""
from __future__ import annotations

import contextvars
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import ORMExecuteState, Session, SessionTransaction
from sqlalchemy.sql.elements import TextClause
from starlette.requests import Request
from starlette.responses import Response

logger = logging.getLogger(__name__)

WROTE_KEY = "commit_before_response_wrote"
COMMIT_FAILED_KEY = "commit_before_response_failed"

_REQUEST_SESSIONS: contextvars.ContextVar[list[AsyncSession] | None] = contextvars.ContextVar(
    "commit_before_response_sessions", default=None,
)
_TEXT_DML = re.compile(r"^\s*(insert|update|delete|merge)\b", re.IGNORECASE)
_TEXT_CTE_DML = re.compile(r"^\s*with\b.*\b(insert|update|delete)\b", re.IGNORECASE | re.DOTALL)


def register_request_session(session: AsyncSession) -> None:
    """Called by get_db / get_worker_db. No-op outside an HTTP request handled by the middleware."""
    holder = _REQUEST_SESSIONS.get()
    if holder is not None:
        holder.append(session)


@event.listens_for(Session, "after_flush")
def _mark_flush(session: Session, flush_context: Any) -> None:
    session.info[WROTE_KEY] = True


@event.listens_for(Session, "after_transaction_end")
def _clear_mark(session: Session, transaction: SessionTransaction) -> None:
    # Only when the outermost transaction ends (commit or rollback): then nothing is left to commit, so no empty COMMIT before the
    # headers. A SAVEPOINT (or other inner transaction) ending leaves the outer write marked. Clearing on after_commit /
    # after_rollback instead lost that mark when a SAVEPOINT was released or rolled back (both savepoint tests failed).
    if transaction.parent is None:
        session.info[WROTE_KEY] = False


@event.listens_for(Session, "do_orm_execute")
def _mark_dml(state: ORMExecuteState) -> None:
    if state.is_insert or state.is_update or state.is_delete:
        state.session.info[WROTE_KEY] = True
        return
    stmt = state.statement
    if isinstance(stmt, TextClause) and (_TEXT_DML.match(stmt.text) or _TEXT_CTE_DML.match(stmt.text)):
        state.session.info[WROTE_KEY] = True


def session_wrote(session: AsyncSession) -> bool:
    return bool(session.info.get(WROTE_KEY) or session.new or session.dirty or session.deleted)


async def _commit(session: AsyncSession) -> None:
    """The early commit itself (a seam for the failure-path test)."""
    await session.commit()


async def _commit_written(sessions: list[AsyncSession]) -> None:
    """Commit every session that wrote. If a commit fails, that session is rolled back and flagged, and the error is re-raised."""
    for session in sessions:
        if session.info.get(COMMIT_FAILED_KEY) or not session_wrote(session):
            continue
        try:
            await _commit(session)
        except Exception:
            session.info[COMMIT_FAILED_KEY] = True
            try:
                await session.rollback()
            except Exception:
                logger.exception("rollback after a failed commit before response also raised")
            raise


ErrorHandler = Callable[[Request, Exception], Awaitable[Response]]


class CommitBeforeResponseMiddleware:
    """Pure ASGI. Must be the innermost user middleware (added first in main.py) so every response of the app — including the ones
    exception handlers build — passes through it, and CORS / metering layers wrap the final status.

    error_handler: the app's unhandled-exception handler (main.unhandled_exception_handler). A failed commit is answered exactly as
    if the endpoint had raised: audit row, REST 500 envelope or, on the A2A /rpc path, a JSON-RPC error.
    replay_body_for: paths whose request body the error handler reads again (the JSON-RPC id on /rpc). Only those bodies are kept,
    so large uploads elsewhere are not held in memory.
    """

    def __init__(self, app: Any, error_handler: ErrorHandler, replay_body_for: Callable[[str], bool] = lambda _path: False) -> None:
        self.app = app
        self.error_handler = error_handler
        self.replay_body_for = replay_body_for

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        holder: list[AsyncSession] = []
        token = _REQUEST_SESSIONS.set(holder)
        replaced = False
        body_chunks: list[bytes] | None = [] if self.replay_body_for(scope.get("path", "")) else None

        async def receive_wrapper() -> dict:
            message = await receive()
            if body_chunks is not None and message.get("type") == "http.request":
                body_chunks.append(message.get("body", b""))
            return message

        async def replay_receive() -> dict:
            return {"type": "http.request", "body": b"".join(body_chunks or []), "more_body": False}

        async def send_wrapper(message: dict) -> None:
            nonlocal replaced
            if replaced:
                return  # the original response was replaced by the failure response — drop its remaining messages
            if message.get("type") == "http.response.start" and holder:
                try:
                    await _commit_written(holder)
                except Exception as exc:  # noqa: BLE001 — any commit failure becomes the handler's response, never a false success
                    replaced = True
                    request = Request(scope, replay_receive if body_chunks is not None else receive)
                    response = await self.error_handler(request, exc)  # inside `except`: its log keeps the traceback
                    await response(scope, replay_receive, send)
                    return
            await send(message)

        try:
            await self.app(scope, receive_wrapper if body_chunks is not None else receive, send_wrapper)
        finally:
            _REQUEST_SESSIONS.reset(token)
