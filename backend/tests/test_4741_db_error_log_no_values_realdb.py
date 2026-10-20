"""story #4741 (Kadir lens on #5172) — a database error never reaches a log line, an error event or a response with the values of the row it was about.

The marker is planted in the value the database refuses, once per way a database can refuse it (a NUL, a CHECK, a length, a UNIQUE, and a value asyncpg itself refuses before the
server sees it — its message quotes the value); each goes through the REAL unhandled-exception handler (app/main.py) of the REAL app against a real database, and the marker is
looked for in every log record of every logger (message, arguments, formatted traceback, Cloud Logging JSON), in the `unhandled_error_events` row and in the response.
What must stay (debugging): the SQLSTATE and the constraint / table names, no values.
"""
from __future__ import annotations

import json
import logging
import uuid

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures
    _client,
    _dispose_global_engine_after_test,
    anyio_backend,
)

pytestmark = pytest.mark.anyio

MARK = "secret-MARK-4741"
PATH = "/__t4741_db_error/{kind}"


def _boom_route():
    from sqlalchemy import text

    from app.core.database import async_session_factory

    async def boom(kind: str):
        async with async_session_factory() as s:
            await s.execute(text("CREATE TEMP TABLE t4741 (a text CHECK (a NOT LIKE 'bad%'), b varchar(5), c text UNIQUE, n integer, j jsonb)"))
            if kind == "nul":
                await s.execute(text("INSERT INTO t4741 (a) VALUES (:v)"), {"v": f"{MARK}\x00x"})
            elif kind == "jsonb_nul":
                await s.execute(text("INSERT INTO t4741 (j) VALUES (CAST(:v AS jsonb))"), {"v": json.dumps({"k": f"{MARK}\x00x"}).replace("\\u0000", "\\u0000")})
            elif kind == "check":
                await s.execute(text("INSERT INTO t4741 (a) VALUES (:v)"), {"v": f"bad-{MARK}"})
            elif kind == "toolong":
                await s.execute(text("INSERT INTO t4741 (b) VALUES (:v)"), {"v": f"{MARK}-way-too-long"})
            elif kind == "unique":
                await s.execute(text("INSERT INTO t4741 (c) VALUES (:v)"), {"v": MARK})
                await s.execute(text("INSERT INTO t4741 (c) VALUES (:v)"), {"v": MARK})
            elif kind == "datatype":  # asyncpg refuses it before the server sees it — and quotes the value in its own message
                await s.execute(text("INSERT INTO t4741 (n) VALUES (:v)"), {"v": MARK})
        return {"ok": True}

    return boom


@pytest.fixture
def boom_route():
    from app.main import app

    before = list(app.router.routes)
    app.add_api_route(PATH, _boom_route(), methods=["GET"])
    yield
    app.router.routes[:] = before


def _watch(caplog):
    """Attach the capture again (importing the app configures logging and clears the root handlers) and keep every logger at DEBUG."""
    from app.main import app  # noqa: F401

    logging.getLogger().addHandler(caplog.handler)
    caplog.set_level(logging.DEBUG)


def _everything_a_record_can_say(caplog) -> list[str]:
    from app.core.logging_config import JsonFormatter

    fmt = JsonFormatter()
    texts: list[str] = []
    for r in caplog.records:
        texts += [r.getMessage(), str(r.args), fmt.format(r)]
        if r.exc_info:
            texts.append(logging.Formatter().formatException(r.exc_info))
    return texts


async def _event(error_id: str):
    from sqlalchemy import select

    from app.core.database import async_session_factory
    from app.models.unhandled_error_event import UnhandledErrorEvent

    async with async_session_factory() as s:
        return (await s.execute(select(UnhandledErrorEvent).where(UnhandledErrorEvent.id == uuid.UUID(error_id)))).scalar_one_or_none()


@pytest.mark.parametrize("kind,expect", [
    ("nul", {"sqlstate": None}),
    ("jsonb_nul", {"sqlstate": None}),
    ("check", {"sqlstate": "23514", "constraint": "t4741_a_check", "table": "t4741"}),
    ("toolong", {"sqlstate": "22001"}),
    ("unique", {"sqlstate": "23505", "constraint": "t4741_c_key", "table": "t4741"}),
    ("datatype", {"sqlstate": None}),
])
async def test_01_a_database_error_is_logged_stored_and_answered_without_the_value_but_with_its_sqlstate_and_constraint(boom_route, caplog, kind, expect):
    _watch(caplog)
    async with _client() as c:
        r = await c.get(PATH.format(kind=kind))
    assert r.status_code == 500, r.text
    error_id = r.json()["error"]["error_id"]
    assert MARK not in r.text
    # the log: not one record of any logger carries the value — in its message, its arguments, its traceback text or its Cloud Logging JSON
    leaked = [t[:300] for t in _everything_a_record_can_say(caplog) if MARK in t]
    assert leaked == [], leaked
    # …and the line that remains is enough to debug: the handler's own record names the class and the SQLSTATE / constraint / table
    lines = [r.getMessage() for r in caplog.records if r.name == "app.main" and error_id in r.getMessage()]
    assert len(lines) == 1, lines
    assert "Unhandled exception on GET" in lines[0]
    for label, want in expect.items():
        if want is not None:
            assert f"{label}={want}" in lines[0], (label, lines[0])
    # the event row (30 days in the database) holds the same safe text, not the exception's
    event = await _event(error_id)
    assert event is not None and MARK not in (event.message or ""), event and event.message
    if expect.get("sqlstate"):
        assert f"sqlstate={expect['sqlstate']}" in (event.message or "")


async def test_02_the_debug_response_carries_the_safe_text_not_the_exception(boom_route, caplog, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "debug", True)
    _watch(caplog)
    async with _client() as c:
        r = await c.get(PATH.format(kind="check"))
    assert r.status_code == 500 and MARK not in r.text, r.text
    assert "sqlstate=23514" in r.json()["error"]["message"] and "constraint=t4741_a_check" in r.json()["error"]["message"]


def test_03_every_engine_hides_the_bound_parameters():
    from app.core.database import _build_engine_kwargs, engine, read_engine, worker_engine
    from app.core.config import settings

    for e in (engine, read_engine, worker_engine):
        assert e.sync_engine.hide_parameters is True
    assert _build_engine_kwargs()["hide_parameters"] is True
    # also on the PgBouncer branch
    original = settings.db_pgbouncer
    try:
        settings.db_pgbouncer = True
        assert _build_engine_kwargs()["hide_parameters"] is True
    finally:
        settings.db_pgbouncer = original


async def test_04_other_log_sites_are_covered_too_a_wrapped_cause_a_message_argument_an_exc_info_and_a_dict_argument(boom_route, caplog):
    """The redaction is at the LogRecord, so it does not matter which module logs the error or how: `logger.exception`, `logger.error("…%s", exc)`, `exc_info=exc`,
    a named argument — and an exception that merely HAS a database error as its cause."""
    from sqlalchemy import text

    from app.core.database import async_session_factory

    _watch(caplog)
    other = logging.getLogger("app.services.some_background_job")
    errors: list[BaseException] = []
    async with async_session_factory() as s:
        try:
            await s.execute(text("CREATE TEMP TABLE t4741b (c text UNIQUE)"))
            await s.execute(text("INSERT INTO t4741b (c) VALUES (:v)"), {"v": MARK})
            await s.execute(text("INSERT INTO t4741b (c) VALUES (:v)"), {"v": MARK})
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)
            other.exception("job failed")                                    # exc_info from the active exception
            other.error("save failed: %s", exc)                              # the exception as a %s argument
            other.warning("again", exc_info=exc)                             # exc_info=exception
            other.error("named %(why)s", {"why": exc})                       # a mapping argument
            try:
                raise RuntimeError("the job gave up") from exc
            except RuntimeError as wrapped:
                other.exception("wrapped")                                    # a non-database exception whose cause is one
                assert wrapped.__cause__ is exc
    assert errors
    texts = _everything_a_record_can_say(caplog)
    assert MARK not in " ".join(texts)
    mine = [r for r in caplog.records if r.name == "app.services.some_background_job"]
    assert len(mine) == 5
    assert all("sqlstate=23505" in " ".join(t for t in _everything_a_record_can_say_for(r)) or "wrapped" in r.getMessage() or "job gave up" in " ".join(_everything_a_record_can_say_for(r))
               for r in mine)
    # the wrapper keeps its own words, the database error inside it is the safe line
    wrapped_text = " ".join(_everything_a_record_can_say_for(mine[-1]))
    assert "the job gave up" in wrapped_text and "sqlstate=23505" in wrapped_text and "constraint=t4741b_c_key" in wrapped_text


def _everything_a_record_can_say_for(record) -> list[str]:
    from app.core.logging_config import JsonFormatter

    out = [record.getMessage(), JsonFormatter().format(record)]
    if record.exc_info:
        out.append(logging.Formatter().formatException(record.exc_info))
    return out


def test_05_a_record_without_a_database_error_is_left_exactly_as_it_was():
    from app.core.db_error_redaction import install_record_redaction, redact_record

    install_record_redaction()
    plain = ValueError(f"bad input {MARK}")
    rec = logging.getLogger("x").makeRecord("x", logging.ERROR, __file__, 1, "failed: %s", (plain,), (type(plain), plain, None))
    assert rec.args == (plain,) and rec.exc_info == (type(plain), plain, None) and rec.getMessage() == f"failed: bad input {MARK}"
    assert redact_record(rec) is rec and rec.args[0] is plain


def test_06_the_summary_names_classes_sqlstate_and_identifiers_only():
    from sqlalchemy.exc import IntegrityError

    from app.core.db_error_redaction import db_error_summary, has_db_error, redact_exception

    class Cause(Exception):
        sqlstate = "23505"
        constraint_name = "uq_things_slug"
        table_name = "things"
        detail = f"Key (slug)=({MARK}) already exists."

    orig = Cause(f"duplicate key value violates unique constraint — {MARK}")
    exc = IntegrityError("INSERT INTO things VALUES (%s)", (MARK,), orig)
    exc.orig.__cause__ = None
    assert has_db_error(exc)
    summary = db_error_summary(exc)
    assert MARK not in summary and "sqlstate=23505" in summary and "constraint=uq_things_slug" in summary and "table=things" in summary and summary.startswith("IntegrityError")
    # an identifier with spaces, quotes or a value-like tail is not echoed
    orig.constraint_name = f"x y '{MARK}'"
    assert MARK not in db_error_summary(exc) and "constraint=" not in db_error_summary(exc)
    # a chain with no database error has nothing to hide
    assert redact_exception(RuntimeError("plain")) is None and not has_db_error(RuntimeError("plain"))


# ── codex read of the first head: branches and groups, nested arguments and `extra`, the realtime process, a handled catch-all that answers with the text ───────────────────


def _db_error(text_marker: str = MARK):
    """A database error as SQLAlchemy builds it — the statement, its parameters, and a driver error whose own words quote the value."""
    from sqlalchemy.exc import IntegrityError

    class DriverError(Exception):
        sqlstate = "23505"
        constraint_name = "uq_things_slug"
        table_name = "things"

    return IntegrityError("INSERT INTO things (slug) VALUES (%s)", (text_marker,), DriverError(f"duplicate key value … Key (slug)=({text_marker})"))


def _record_texts(records) -> str:
    return " ".join(t for r in records for t in _everything_a_record_can_say_for_record(r))


def _everything_a_record_can_say_for_record(record) -> list[str]:
    from app.core.logging_config import JsonFormatter

    out = [record.getMessage(), str(record.args), JsonFormatter().format(record), *(str(v) for k, v in record.__dict__.items() if k in ("err", "errs", "wrap"))]
    if record.exc_info:
        out.append(logging.Formatter().formatException(record.exc_info))
    return out


def test_07_a_branch_a_group_or_a_deep_chain_with_a_database_error_in_it_is_still_redacted(caplog):
    _watch(caplog)
    log = logging.getLogger("app.services.graph")
    # 1. an exception with a cause that is NOT a database error and a context that IS one (a second way back)
    try:
        try:
            raise _db_error()
        except Exception as db:
            try:
                raise ValueError("plain cause")
            except ValueError as plain:
                raise RuntimeError("wrapper") from plain  # cause = plain, context = plain (raised while handling db? plain was raised in the db handler)
    except RuntimeError as e:
        e.__context__ = _db_error()  # a context that is a database error, beside a cause that is not
        log.error("branch", exc_info=e)
    # 2. an ExceptionGroup whose member is one
    try:
        raise ExceptionGroup("several things failed", [ValueError("a"), _db_error()])
    except ExceptionGroup as g:
        log.error("group", exc_info=g)
    # 3. a chain deeper than the old cap with the database error at the bottom
    e = _db_error()
    for i in range(12):
        nxt = RuntimeError(f"level {i}")
        nxt.__cause__ = e
        e = nxt
    log.error("deep", exc_info=e)
    mine = [r for r in caplog.records if r.name == "app.services.graph"]
    assert len(mine) == 3
    assert MARK not in _record_texts(mine)
    assert all("sqlstate=23505" in _record_texts([r]) for r in mine)


def test_08_exceptions_nested_in_log_arguments_or_extra_fields_are_redacted_too(caplog):
    _watch(caplog)
    log = logging.getLogger("app.services.nested")
    exc = _db_error()
    log.error("list %s", [exc])
    log.error("tuple-in-dict %(why)s", {"why": (exc, "x")})
    log.error("extra", extra={"err": exc, "errs": [exc, exc], "wrap": {"inner": exc}})
    mine = [r for r in caplog.records if r.name == "app.services.nested"]
    assert len(mine) == 3
    assert MARK not in _record_texts(mine)
    assert "sqlstate=23505" in _record_texts(mine)


async def test_09_the_realtime_process_answers_and_stores_the_safe_text_too(caplog, monkeypatch):
    from starlette.requests import Request

    from app.core.config import settings
    from app.realtime_main import unhandled_exception_handler

    monkeypatch.setattr(settings, "debug", True)
    _watch(caplog)
    request = Request({"type": "http", "method": "GET", "path": "/realtime-probe", "headers": [], "query_string": b"", "state": {}})
    response = await unhandled_exception_handler(request, _db_error())
    body = json.loads(response.body)
    assert response.status_code == 500 and MARK not in response.body.decode() and "sqlstate=23505" in body["error"]["message"]
    event = await _event(body["error"]["error_id"])
    assert event is not None and MARK not in (event.message or "") and "sqlstate=23505" in event.message
    assert MARK not in _record_texts(caplog.records)


async def test_10_a_handled_catch_all_that_answers_with_the_exception_text_gets_the_safe_text(monkeypatch):
    import types

    from fastapi import HTTPException

    from app.routers import retros

    async def allowed(*_a, **_k):
        return None

    class Repo:
        org_id = uuid.uuid4()

        async def set_phase(self, *_a):
            raise _db_error()

    monkeypatch.setattr(retros, "_require_retro_project_access", allowed)
    with pytest.raises(HTTPException) as caught:
        await retros.advance_phase(uuid.uuid4(), types.SimpleNamespace(phase="x"), None, types.SimpleNamespace(user_id=str(uuid.uuid4())), Repo())
    assert caught.value.status_code == 400 and MARK not in str(caught.value.detail) and "sqlstate=23505" in caught.value.detail
    # a plain ValueError keeps its words
    class Plain(Repo):
        async def set_phase(self, *_a):
            raise ValueError("phase must be one of discuss, vote")

    with pytest.raises(HTTPException) as caught:
        await retros.advance_phase(uuid.uuid4(), types.SimpleNamespace(phase="x"), None, types.SimpleNamespace(user_id=str(uuid.uuid4())), Plain())
    assert caught.value.detail == "phase must be one of discuss, vote"


# ── Kadir lens on #5174 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def test_11_a_session_used_again_after_a_failed_flush_carries_the_original_error_and_is_redacted(caplog):
    from sqlalchemy.exc import InvalidRequestError, PendingRollbackError

    from app.core.db_error_redaction import has_db_error, safe_exception_text

    original = f"(sqlalchemy.dialects.postgresql.asyncpg.IntegrityError) duplicate key value violates unique constraint \"uq_x\" DETAIL: Key (slug)=({MARK}) already exists. [SQL: INSERT INTO x (slug) VALUES ($1)]"
    for exc in (
        PendingRollbackError(f"This Session's transaction has been rolled back due to a previous exception during flush. Original exception was: {original}"),
        InvalidRequestError(f"Can't reconnect until invalid transaction is rolled back. Original exception was: {original}"),
    ):
        assert has_db_error(exc) and MARK not in safe_exception_text(exc)
    _watch(caplog)
    logging.getLogger("app.services.session_reuse").error("again", exc_info=PendingRollbackError(f"rolled back. Original exception was: {original}"))
    assert MARK not in _record_texts([r for r in caplog.records if r.name == "app.services.session_reuse"])
    # a usage error of SQLAlchemy that says nothing about a row keeps its words
    assert not has_db_error(InvalidRequestError("Object is already attached to session"))


def test_12_a_chain_of_fifty_levels_is_followed_to_the_database_error():
    from app.core.db_error_redaction import has_db_error

    e = _db_error()
    for i in range(45):
        nxt = RuntimeError(f"level {i}")
        nxt.__cause__ = e
        e = nxt
    assert has_db_error(e)


_LOG_METHODS = {"debug", "info", "warning", "warn", "error", "exception", "critical", "fatal", "log"}
_EXC_NAMES = {"exc", "e", "ex", "err", "error", "exception"}


def _log_calls_that_print_exception_text(root) -> set[tuple[str, int]]:
    """Log calls under backend/app whose message or arguments build text out of an exception: `str(exc)`, `exc.args`, an f-string with `{exc}`, `repr(exc)`, `"…" % exc`
    or `.format(exc)`. A database error's text carries the row's values, and the record redaction only sees exception OBJECTS — text built before the call gets past it."""
    import ast
    from pathlib import Path

    def mentions_exception_text(node) -> bool:
        for n in ast.walk(node):
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in {"str", "repr"} and n.args and isinstance(n.args[0], ast.Name) and n.args[0].id in _EXC_NAMES:
                return True
            if isinstance(n, ast.Attribute) and n.attr == "args" and isinstance(n.value, ast.Name) and n.value.id in _EXC_NAMES:
                return True
            if isinstance(n, ast.JoinedStr) and any(isinstance(v, ast.FormattedValue) and isinstance(v.value, ast.Name) and v.value.id in _EXC_NAMES for v in n.values):
                return True
            if isinstance(n, ast.BinOp) and isinstance(n.op, ast.Mod) and isinstance(n.left, ast.Constant) and isinstance(n.left.value, str) and (
                (isinstance(n.right, ast.Name) and n.right.id in _EXC_NAMES) or (isinstance(n.right, ast.Tuple) and any(isinstance(x, ast.Name) and x.id in _EXC_NAMES for x in n.right.elts))
            ):
                return True
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "format" and any(isinstance(a, ast.Name) and a.id in _EXC_NAMES for a in n.args):
                return True
        return False

    def text_names(func) -> set[str]:
        """Names a function sets from exception text (`error_msg = str(exc)[:500]`) — handing such a name to a log call is the same as building the text in the call."""
        names: set[str] = set()
        for n in ast.walk(func):
            if isinstance(n, ast.Assign) and mentions_exception_text(n.value):
                names.update(t.id for t in n.targets if isinstance(t, ast.Name))
            elif isinstance(n, ast.AnnAssign) and n.value is not None and mentions_exception_text(n.value) and isinstance(n.target, ast.Name):
                names.add(n.target.id)
        return names

    found: set[tuple[str, int]] = set()
    for path in sorted(Path(root).rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        rel = str(path.relative_to(Path(root).parent))
        funcs = [f for f in ast.walk(tree) if isinstance(f, (ast.FunctionDef, ast.AsyncFunctionDef))]
        for func in funcs:
            names = text_names(func)
            for n in ast.walk(func):
                if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in _LOG_METHODS:
                    base = n.func.value
                    name = base.id if isinstance(base, ast.Name) else getattr(base, "attr", "")
                    if name in {"logger", "_logger", "log", "logging", "LOGGER", "_log"}:
                        args = [*n.args, *[k.value for k in n.keywords]]
                        if any(mentions_exception_text(a) or any(isinstance(x, ast.Name) and x.id in names for x in ast.walk(a)) for a in args):
                            found.add((rel, n.lineno))
    return found


def test_13_no_log_call_in_the_app_builds_text_out_of_an_exception_before_the_record(tmp_path):
    from pathlib import Path

    app = Path(__file__).resolve().parent.parent / "app"
    assert _log_calls_that_print_exception_text(app) == set(), (
        "a log call builds text from an exception (str(exc) / exc.args / f\"{exc}\" / % exc / .format(exc)) — pass the exception OBJECT (a %s argument or exc_info) so the record "
        "redaction sees it, or use app.core.db_error_redaction.safe_exception_text"
    )
    pkg = tmp_path / "app"
    pkg.mkdir()
    (pkg / "z.py").write_text(
        "def a(exc):\n    logger.error(str(exc))\n"
        "def b(e):\n    logger.warning(f'failed {e}')\n"
        "def c(err):\n    _logger.info('x %s' % err)\n"
        "def d(exc):\n    log.error('x', exc.args)\n"
        "def e2(exc):\n    logger.error('x %s', exc)\n"
        "def f(exc):\n    logger.exception('x')\n"
        "def g(exc):\n    other.error(str(exc))\n"
        "def h(exc):\n    msg = str(exc)[:500]\n    logger.warning('x %s', msg)\n"
        "def i(exc):\n    msg = 'fixed'\n    logger.warning('x %s', msg)\n"
    )
    assert _log_calls_that_print_exception_text(pkg) == {("app/z.py", 2), ("app/z.py", 4), ("app/z.py", 6), ("app/z.py", 8), ("app/z.py", 17)}


async def test_14_a_delivery_status_update_that_the_database_refuses_leaves_no_value_in_the_log_or_the_stored_last_error(caplog, monkeypatch):
    """`_retry_deliver` turned the exception into text (`error_msg`) BEFORE logging it and storing it in `last_error` — the record redaction never saw an exception object."""
    import uuid as _uuid

    from app.services import conversation_webhook as cw

    stored: list[dict] = []

    async def _attempt_ok(url, secret, payload):
        return None

    async def _update(delivery_id, status, **kw):
        if status == "gateway_accepted":
            raise _db_error()
        stored.append({"status": status, **kw})

    async def _no_sleep(_):
        return None

    monkeypatch.setattr(cw, "_attempt_delivery", _attempt_ok)
    monkeypatch.setattr(cw, "_update_delivery_status", _update)
    monkeypatch.setattr(cw.asyncio, "sleep", _no_sleep)
    caplog.set_level(logging.DEBUG)
    await cw._retry_deliver(_uuid.uuid4(), "https://example.invalid/hook", None, {})
    assert MARK not in _record_texts(caplog.records)
    assert stored and stored[-1]["status"] == "failed"
    assert MARK not in json.dumps(stored, default=str)
    assert "sqlstate=23505" in stored[-1]["last_error"] and "uq_things_slug" in stored[-1]["last_error"]
