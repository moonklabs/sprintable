"""story #4389 — a write request's DB commit happens before its response headers are sent (real PG · the real app and get_db).

Before, get_db committed in its teardown, which FastAPI 0.136 runs **after the response is sent** (default dependency scope
"request"). A client could hold a 201 for a row not committed yet (create a folder, then a doc under it: 404 in 1/300 and 1/1000
back-to-back pairs on a real uvicorn), and a commit that failed there was hidden behind the success already sent.

The ASGI app is driven by hand here so the test can look at the database **at the moment the response headers are sent** — through a
separate connection. That is the exact property; a normal client only sees the response after the whole request finished.
"""
from __future__ import annotations

import contextlib
import json
import os
import uuid
from typing import Annotated

import pytest
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.database import get_db

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")
pytestmark = [pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip"), pytest.mark.anyio]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@contextlib.asynccontextmanager
async def _env(monkeypatch):
    """The real app with the real get_db / get_worker_db, their session factories pointed at the test DB, one seeded user.
    Entered inside each test (the engine must live on the test's own event loop)."""
    import app.dependencies.auth as auth_module
    from app.core import database
    from app.core.security import create_access_token

    eng = create_async_engine(_ASYNC)
    Session = async_sessionmaker(eng, expire_on_commit=False, class_=AsyncSession)
    monkeypatch.setattr(database, "async_session_factory", Session)
    monkeypatch.setattr(database, "worker_session_factory", Session)
    monkeypatch.setattr(database, "read_session_factory", Session)
    monkeypatch.setattr(auth_module, "async_session_factory", Session)
    org, user, proj = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    async with Session() as s:
        await s.execute(text(f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{org}','O','o-{org.hex[:12]}','free')"))
        await s.execute(text(
            "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) "
            f"VALUES ('{user}','u{user.hex[:8]}@s4389.test','x','U',true,true,0,false,0)"
        ))
        await s.execute(text(f"INSERT INTO org_members (id,org_id,user_id,role) VALUES (gen_random_uuid(),'{org}','{user}','admin')"))
        await s.execute(text(f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES ('{proj}','{org}','P','p-{proj.hex[:12]}','warn')"))
        await s.commit()
    tok = create_access_token(str(user), email="u@s4389.test", app_metadata={"org_id": str(org)})
    try:
        yield {"org": org, "proj": proj, "token": tok, "Session": Session, "engine": eng}
    finally:
        async with Session() as s:
            for q in (
                "DELETE FROM unhandled_error_events WHERE exception_class = 'InjectedCommitFailure'",
                f"DELETE FROM docs WHERE org_id = '{org}'",
                f"DELETE FROM org_members WHERE org_id = '{org}'",
                f"DELETE FROM projects WHERE org_id = '{org}'",
                f"DELETE FROM organizations WHERE id = '{org}'",
                f"DELETE FROM users WHERE id = '{user}'",
            ):
                await s.execute(text(q))
            await s.commit()
        await eng.dispose()


async def _call(asgi_app, method: str, path: str, *, token: str | None = None, body: dict | None = None, on_start=None,
                headers: list[tuple[bytes, bytes]] | None = None):
    """Drive one HTTP request through the ASGI app. `on_start(status)` runs when the response headers are sent."""
    payload = json.dumps(body).encode() if body is not None else b""
    hdrs = [(b"host", b"t"), (b"content-type", b"application/json")] + (headers or [])
    if token:
        hdrs.append((b"authorization", f"Bearer {token}".encode()))
    path_only, _, query = path.partition("?")
    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method, "scheme": "http",
        "path": path_only, "raw_path": path_only.encode(), "query_string": query.encode(), "headers": hdrs,
        "client": ("127.0.0.1", 1), "server": ("t", 80), "root_path": "",
    }
    sent = False

    async def receive():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": payload, "more_body": False}
        return {"type": "http.disconnect"}

    result = {"status": None, "body": b""}

    async def send(message):
        if message["type"] == "http.response.start":
            result["status"] = message["status"]
            if on_start is not None:
                await on_start(message["status"])
        elif message["type"] == "http.response.body":
            result["body"] += message.get("body", b"")

    await asgi_app(scope, receive, send)
    return result


def _doc_body(env, slug: str, **extra) -> dict:
    return {"org_id": str(env["org"]), "project_id": str(env["proj"]), "slug": slug, "title": "t", "content": "", **extra}


async def _count_docs(env, slug: str) -> int:
    async with env["engine"].connect() as conn:  # a separate connection — sees committed rows only
        return (await conn.execute(text("SELECT count(*) FROM docs WHERE slug = :s"), {"s": slug})).scalar_one()


class InjectedCommitFailure(RuntimeError):
    """The failure injected into the early commit (its class name marks the audit rows these tests create)."""


async def _audit_rows(env, error_id: str) -> list[tuple]:
    async with env["engine"].connect() as conn:
        return list((await conn.execute(
            text("SELECT method, path, exception_class FROM unhandled_error_events WHERE id = :i"), {"i": error_id},
        )).all())


def _inject_commit_failure(monkeypatch) -> list:
    import app.core.commit_before_response as cbr

    failed_sessions: list = []

    async def failing_early_commit(session):
        failed_sessions.append(session)
        raise InjectedCommitFailure("injected commit failure")

    monkeypatch.setattr(cbr, "_commit", failing_early_commit)
    return failed_sessions


async def test_write_is_committed_when_the_response_headers_go_out(monkeypatch):
    async with _env(monkeypatch) as env:
        from app.main import app

        slug = f"c4389-{uuid.uuid4().hex[:10]}"
        seen: dict = {}

        async def at_headers(status):
            seen["status"] = status
            seen["committed_rows"] = await _count_docs(env, slug)

        res = await _call(app, "POST", "/api/v2/docs", token=env["token"], body=_doc_body(env, slug), on_start=at_headers)
        assert res["status"] == 201, res["body"][:300]
        assert seen == {"status": 201, "committed_rows": 1}  # before: 0 — the commit came after the headers



async def test_folder_then_child_right_away_finds_its_parent(monkeypatch):
    """The reported shape (e2e crumb setup): create a folder, then a doc under it with the id from the 201."""
    async with _env(monkeypatch) as env:
        from app.main import app

        stamp = uuid.uuid4().hex[:10]
        folder = await _call(app, "POST", "/api/v2/docs", token=env["token"], body=_doc_body(env, f"f4389-{stamp}", is_folder=True))
        assert folder["status"] == 201
        fid = json.loads(folder["body"])["id"] if "id" in json.loads(folder["body"]) else json.loads(folder["body"])["data"]["id"]
        child = await _call(app, "POST", "/api/v2/docs", token=env["token"], body=_doc_body(env, f"d4389-{stamp}", parent_id=fid))
        assert child["status"] == 201, child["body"][:300]



async def test_read_request_makes_no_commit_before_its_headers(monkeypatch):
    """PO condition ① — a read-only request is not charged a COMMIT round trip inside the user's wait."""
    async with _env(monkeypatch) as env:
        from app.main import app

        calls = {"n": 0, "before_headers": None}
        real_commit = AsyncSession.commit

        async def counting_commit(self):
            calls["n"] += 1
            return await real_commit(self)

        monkeypatch.setattr(AsyncSession, "commit", counting_commit)

        async def at_headers(status):
            calls["before_headers"] = calls["n"]

        res = await _call(app, "GET", f"/api/v2/docs?project_id={env['proj']}", token=env["token"], on_start=at_headers)
        assert res["status"] == 200
        assert calls["before_headers"] == 0



async def test_failed_commit_becomes_a_500_and_the_teardown_rolls_back(monkeypatch):
    """PO condition ② — the early commit fails → the client gets the app's 500 (not 201), nothing is persisted, and get_db's
    teardown rolls back instead of committing that session again. It goes through the app's unhandled-exception handler, like an
    endpoint that raised: the unhandled_error_events audit row carries the same error_id as the envelope (PO 11:33Z ①)."""
    async with _env(monkeypatch) as env:
        import app.core.commit_before_response as cbr
        from app.main import app

        slug = f"x4389-{uuid.uuid4().hex[:10]}"
        failed_sessions = _inject_commit_failure(monkeypatch)
        commits_after_failure = {"n": 0}
        real_commit = AsyncSession.commit

        async def watching_commit(self):
            if self.info.get(cbr.COMMIT_FAILED_KEY):
                commits_after_failure["n"] += 1
            return await real_commit(self)

        monkeypatch.setattr(AsyncSession, "commit", watching_commit)
        res = await _call(app, "POST", "/api/v2/docs", token=env["token"], body=_doc_body(env, slug))
        assert res["status"] == 500
        body = json.loads(res["body"])
        assert body["data"] is None and body["error"]["code"] == "INTERNAL_ERROR"
        assert await _audit_rows(env, body["error"]["error_id"]) == [("POST", "/api/v2/docs", "InjectedCommitFailure")]
        assert len(failed_sessions) == 1               # the early commit ran once and failed
        assert commits_after_failure["n"] == 0         # the teardown did not commit the failed session again
        assert await _count_docs(env, slug) == 0       # rolled back — nothing persisted


async def test_error_response_is_not_committed_early(monkeypatch):
    """PO condition ③ — a 4xx built by an exception handler passes through untouched: no commit before its headers."""
    async with _env(monkeypatch) as env:
        from app.main import app

        calls = {"n": 0, "before_headers": None}
        real_commit = AsyncSession.commit

        async def counting_commit(self):
            calls["n"] += 1
            return await real_commit(self)

        monkeypatch.setattr(AsyncSession, "commit", counting_commit)

        async def at_headers(status):
            calls["before_headers"] = calls["n"]

        res = await _call(
            app, "POST", "/api/v2/docs", token=env["token"],
            body=_doc_body(env, f"e4389-{uuid.uuid4().hex[:8]}", parent_id=str(uuid.uuid4())), on_start=at_headers,
        )
        assert res["status"] == 404
        assert calls["before_headers"] == 0



async def test_request_without_a_db_session_passes_through(monkeypatch):
    """PO condition ③ — no get_db in the request: the middleware does nothing."""
    async with _env(monkeypatch):
        from app.main import app

        res = await _call(app, "GET", "/api/v2/health")
        assert res["status"] == 200



async def test_cors_preflight_passes_through(monkeypatch):
    async with _env(monkeypatch):
        from app.main import app

        res = await _call(app, "OPTIONS", "/api/v2/docs", headers=[
            (b"origin", b"http://localhost:3000"), (b"access-control-request-method", b"POST"),
        ])
        assert res["status"] in (200, 400)



def test_middleware_is_the_innermost_user_middleware():
    from app.core.commit_before_response import CommitBeforeResponseMiddleware
    from app.main import app, unhandled_exception_handler
    from app.routers import a2a

    innermost = app.user_middleware[-1]
    assert innermost.cls is CommitBeforeResponseMiddleware
    # A failed commit is answered by the app's own handler, and /rpc bodies are replayed to it for the JSON-RPC id.
    assert innermost.kwargs == {"error_handler": unhandled_exception_handler, "replay_body_for": a2a.is_a2a_rpc_path}


async def test_background_task_write_after_the_response_still_commits(monkeypatch):
    """AC2 — a write made after the response on the request session (BackgroundTasks) still commits in get_db's teardown.
    A small app with the real get_db and middleware (no production route writes this way deterministically enough to test)."""
    async with _env(monkeypatch) as env:
        from app.core.commit_before_response import CommitBeforeResponseMiddleware
        from app.main import unhandled_exception_handler

        mini = FastAPI()
        mini.add_middleware(CommitBeforeResponseMiddleware, error_handler=unhandled_exception_handler)
        slug_main, slug_bg = f"m4389-{uuid.uuid4().hex[:8]}", f"b4389-{uuid.uuid4().hex[:8]}"

        async def insert(session: AsyncSession, slug: str) -> None:
            await session.execute(text(
                "INSERT INTO docs (id,org_id,project_id,title,slug,doc_type) "
                f"VALUES (gen_random_uuid(),'{env['org']}','{env['proj']}','t',:s,'page')"
            ), {"s": slug})

        @mini.post("/w", status_code=201)
        async def write(background_tasks: BackgroundTasks, session: Annotated[AsyncSession, Depends(get_db)]):
            await insert(session, slug_main)

            async def later():
                await insert(session, slug_bg)

            background_tasks.add_task(later)
            return {"ok": True}

        seen = {}

        async def at_headers(status):
            seen["main"] = await _count_docs(env, slug_main)
            seen["bg"] = await _count_docs(env, slug_bg)

        res = await _call(mini, "POST", "/w", body={}, on_start=at_headers)
        assert res["status"] == 201
        assert seen == {"main": 1, "bg": 0}          # the endpoint's write is committed before the headers; the background one comes later
        assert await _count_docs(env, slug_bg) == 1   # … and is committed by the teardown


def _mini_app():
    """A small app with the real get_db, the real middleware and the app's own error handler, wired as main.py wires them
    (deterministic shapes the production routes do not isolate)."""
    from app.core.commit_before_response import CommitBeforeResponseMiddleware
    from app.main import unhandled_exception_handler
    from app.routers import a2a

    mini = FastAPI()
    mini.add_middleware(CommitBeforeResponseMiddleware, error_handler=unhandled_exception_handler, replay_body_for=a2a.is_a2a_rpc_path)
    return mini


async def _insert_doc(env, session: AsyncSession, slug: str) -> None:
    await session.execute(text(
        "INSERT INTO docs (id,org_id,project_id,title,slug,doc_type) "
        f"VALUES (gen_random_uuid(),'{env['org']}','{env['proj']}','t',:s,'page')"
    ), {"s": slug})


def _count_early_commits(monkeypatch) -> dict:
    """Counts the middleware's early commits (the seam), leaving every other commit alone."""
    import app.core.commit_before_response as cbr

    calls = {"n": 0}
    real = cbr._commit

    async def counting(session):
        calls["n"] += 1
        await real(session)

    monkeypatch.setattr(cbr, "_commit", counting)
    return calls


async def test_read_only_get_db_session_makes_no_commit_before_its_headers(monkeypatch):
    """PO condition ① — a request whose get_db session only read is not charged a COMMIT inside the user's wait.
    (The production list route reads through get_read_db, which is not registered at all.) Mutation: committing every session
    turns this RED."""
    async with _env(monkeypatch) as env:

        mini = _mini_app()

        @mini.get("/r")
        async def read(session: Annotated[AsyncSession, Depends(get_db)]):
            return {"n": (await session.execute(text("SELECT count(*) FROM docs WHERE org_id = :o"), {"o": str(env["org"])})).scalar_one()}

        calls = {"n": 0, "before_headers": None}
        real_commit = AsyncSession.commit

        async def counting_commit(self):
            calls["n"] += 1
            return await real_commit(self)

        monkeypatch.setattr(AsyncSession, "commit", counting_commit)

        async def at_headers(status):
            calls["before_headers"] = calls["n"]

        res = await _call(mini, "GET", "/r", on_start=at_headers)
        assert res["status"] == 200
        assert calls["before_headers"] == 0


async def test_write_then_error_response_is_not_committed(monkeypatch):
    """PO condition ③ — a route that writes and then raises (4xx) must not have its write committed by the middleware. The exception
    rolls get_db's session back before the error response is sent (FastAPI 0.136), so at the headers there is nothing to commit.
    Pins that order: if it ever changed (e.g. the dependency teardown moved after the response), the row would be committed → RED."""
    async with _env(monkeypatch) as env:

        mini = _mini_app()
        slug = f"r4389-{uuid.uuid4().hex[:8]}"

        @mini.post("/w409")
        async def write_then_conflict(session: Annotated[AsyncSession, Depends(get_db)]):
            await session.execute(text(
                "INSERT INTO docs (id,org_id,project_id,title,slug,doc_type) "
                f"VALUES (gen_random_uuid(),'{env['org']}','{env['proj']}','t',:s,'page')"
            ), {"s": slug})
            raise HTTPException(status_code=409, detail="conflict after write")

        res = await _call(mini, "POST", "/w409", body={})
        assert res["status"] == 409
        assert await _count_docs(env, slug) == 0


async def test_failed_commit_on_the_a2a_rpc_path_is_a_json_rpc_error(monkeypatch):
    """PO 11:33Z ① — agents read /rpc errors as JSON-RPC. A failed early commit there answers like an unhandled exception on /rpc:
    HTTP 200 with a JSON-RPC error (-32603 · the request's id · retryable), plus the audit row. The request body was already read by
    the route; the middleware replays it so the handler still finds the id."""
    async with _env(monkeypatch) as env:
        mini = _mini_app()
        slug = f"j4389-{uuid.uuid4().hex[:8]}"

        @mini.post("/api/v2/a2a/members/{member_id}/rpc")
        async def rpc(member_id: str, payload: dict, session: Annotated[AsyncSession, Depends(get_db)]):
            await _insert_doc(env, session, slug)
            return {"jsonrpc": "2.0", "id": payload["id"], "result": {"ok": True}}

        _inject_commit_failure(monkeypatch)
        res = await _call(mini, "POST", f"/api/v2/a2a/members/{uuid.uuid4()}/rpc", body={"jsonrpc": "2.0", "id": 7, "method": "message/send"})
        assert res["status"] == 200
        body = json.loads(res["body"])
        assert body["jsonrpc"] == "2.0" and body["id"] == 7
        assert body["error"]["code"] == -32603 and body["error"]["data"] == {"retryable": True}
        assert "result" not in body or body["result"] is None
        assert await _count_docs(env, slug) == 0
        async with env["engine"].connect() as conn:
            n = (await conn.execute(text(
                "SELECT count(*) FROM unhandled_error_events WHERE exception_class = 'InjectedCommitFailure' AND path LIKE '/api/v2/a2a/members/%/rpc'"
            ))).scalar_one()
        assert n == 1


async def test_route_that_commits_by_itself_gets_no_early_commit(monkeypatch):
    """PO 11:33Z ② — a route that commits by itself (e.g. cron.py) must not be charged a second, empty COMMIT before its headers.
    The «wrote» mark is cleared on after_commit. Mutation: not clearing it → one early commit here → RED."""
    async with _env(monkeypatch) as env:
        mini = _mini_app()
        slug = f"s4389-{uuid.uuid4().hex[:8]}"

        @mini.post("/self-commit", status_code=201)
        async def self_commit(session: Annotated[AsyncSession, Depends(get_db)]):
            await _insert_doc(env, session, slug)
            await session.commit()
            return {"ok": True}

        early = _count_early_commits(monkeypatch)
        seen = {}

        async def at_headers(status):
            seen["early_commits"] = early["n"]
            seen["committed"] = await _count_docs(env, slug)

        res = await _call(mini, "POST", "/self-commit", body={}, on_start=at_headers)
        assert res["status"] == 201
        assert seen == {"early_commits": 0, "committed": 1}


async def test_route_that_rolls_back_by_itself_gets_no_early_commit(monkeypatch):
    """PO 11:33Z ② — the same for after_rollback: a route that writes, rolls back and answers is not charged a COMMIT."""
    async with _env(monkeypatch) as env:
        mini = _mini_app()
        slug = f"q4389-{uuid.uuid4().hex[:8]}"

        @mini.post("/self-rollback")
        async def self_rollback(session: Annotated[AsyncSession, Depends(get_db)]):
            await _insert_doc(env, session, slug)
            await session.rollback()
            return {"ok": True}

        early = _count_early_commits(monkeypatch)
        res = await _call(mini, "POST", "/self-rollback", body={})
        assert res["status"] == 200
        assert early["n"] == 0
        assert await _count_docs(env, slug) == 0


@pytest.mark.parametrize("savepoint_outcome", ["release", "rollback"])
async def test_savepoint_end_keeps_the_outer_write_marked(monkeypatch, savepoint_outcome):
    """after_commit / after_rollback fire for the outermost transaction only. A SAVEPOINT that is released or rolled back inside
    the request must not clear the mark of the outer write — it is still committed before the headers."""
    async with _env(monkeypatch) as env:
        mini = _mini_app()
        outer, inner = f"o4389-{uuid.uuid4().hex[:8]}", f"i4389-{uuid.uuid4().hex[:8]}"

        @mini.post("/savepoint", status_code=201)
        async def with_savepoint(session: Annotated[AsyncSession, Depends(get_db)]):
            await _insert_doc(env, session, outer)
            nested = await session.begin_nested()
            await _insert_doc(env, session, inner)
            if savepoint_outcome == "release":
                await nested.commit()
            else:
                await nested.rollback()
            return {"ok": True}

        seen = {}

        async def at_headers(status):
            seen["outer"] = await _count_docs(env, outer)
            seen["inner"] = await _count_docs(env, inner)

        res = await _call(mini, "POST", "/savepoint", body={}, on_start=at_headers)
        assert res["status"] == 201
        assert seen == {"outer": 1, "inner": 1 if savepoint_outcome == "release" else 0}

