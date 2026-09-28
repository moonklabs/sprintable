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
- If that commit fails, the session is rolled back and flagged, and the client gets the standard 500 envelope instead of the success
  response (headers were not sent yet). `get_db`'s teardown sees the flag and rolls back instead of committing again.
- Writes made **after** the response (BackgroundTasks on the request session, bodies of streaming responses) still commit in
  `get_db`'s teardown, as before — they are listed in the PR (AC2).

Not covered (commits at teardown, as before): writes issued directly on `session.connection()` bypass `do_orm_execute`. Nothing in
app/ does a write that way today (see the PR table).
"""
from __future__ import annotations

import contextvars
import json
import logging
import re
import uuid
from typing import Any

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import ORMExecuteState, Session
from sqlalchemy.sql.elements import TextClause

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


async def _commit_written(sessions: list[AsyncSession]) -> uuid.UUID | None:
    """Commit every session that wrote. Returns an error id if a commit failed (that session is rolled back and flagged)."""
    for session in sessions:
        if session.info.get(COMMIT_FAILED_KEY) or not session_wrote(session):
            continue
        try:
            await _commit(session)
            session.info[WROTE_KEY] = False
        except Exception:
            error_id = uuid.uuid4()
            logger.exception("commit before response failed [error_id=%s]", error_id)
            session.info[COMMIT_FAILED_KEY] = True
            try:
                await session.rollback()
            except Exception:
                logger.exception("rollback after failed commit also raised [error_id=%s]", error_id)
            return error_id
    return None


def _error_body(error_id: uuid.UUID) -> bytes:
    # Same envelope as main.unhandled_exception_handler (data / error {code, message, error_id} / meta).
    return json.dumps({
        "data": None,
        "error": {"code": "INTERNAL_ERROR", "message": "Internal server error", "error_id": str(error_id)},
        "meta": None,
    }).encode()


class CommitBeforeResponseMiddleware:
    """Pure ASGI. Must be the innermost user middleware (added first in main.py) so every response of the app — including the ones
    exception handlers build — passes through it, and CORS / metering layers wrap the final status."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        holder: list[AsyncSession] = []
        token = _REQUEST_SESSIONS.set(holder)
        replaced = False

        async def send_wrapper(message: dict) -> None:
            nonlocal replaced
            if replaced:
                return  # the original response was replaced by the commit-failure 500 — drop its remaining messages
            if message.get("type") == "http.response.start" and holder:
                error_id = await _commit_written(holder)
                if error_id is not None:
                    replaced = True
                    body = _error_body(error_id)
                    await send({
                        "type": "http.response.start",
                        "status": 500,
                        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
                    })
                    await send({"type": "http.response.body", "body": body, "more_body": False})
                    return
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            _REQUEST_SESSIONS.reset(token)
