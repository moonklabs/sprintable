"""story #4864 — who holds the pool's connections, and since when.

Why: on 11-09 the request pool (20 + 10) was full for hours; every request that needed the database waited 30 s and failed. The database showed
«idle in transaction» sessions of 2–15 hours and only 12 connections for the app's 30 checked-out places — and nothing in the app said which request or
task was holding them. A hold that long is a coroutine waiting for something that never comes while it owns a connection. This module makes the next one
name itself.

- `install(engine, name)` listens to the pool's `checkout` / `checkin` and keeps, per checked-out connection record: the time, the task that checked it out, and the
  request's ASGI scope (the route is read from it when a line is written, not at checkout: routing has happened by then).
- `watch()` is a loop (started in the lifespan): every `pool_holder_poll_sec` it looks at what is checked out and, when one is held longer than `pool_holder_warn_sec`
  or the pool is ≥ 80% out, writes ONE warning line per pool: the counts and the oldest few holders — age · route · the file:line the holding task is awaiting at this moment
  (`Task.get_stack`) · and `task_done` when the task that checked the connection out has already finished (that is a leak, not a wait).
- When SQLAlchemy's garbage collector finds a connection that was never given back («The garbage collector is trying to clean up non-checked-in connection …»,
  logged by the pool's class logger; in async code the collector cannot await the connection's rollback, so SQLAlchemy can only terminate it abruptly), a log filter adds WHERE that
  connection was checked out (the await chain of the task that took it: the last app frames, file:line) to that very line. That line is how the leaking code names itself.
- Nothing here changes a connection, a pool or a request. Every step is inside a try: a failure of the watch is a missing line, never a failed request.
- The scope is kept only while the connection is checked out (a reference in the registry). Nothing from the request is copied into the log line but the route template,
  the method, and code locations — no path ids, headers, query strings or bodies.
"""
from __future__ import annotations

import asyncio
import logging
import re
import sys
import time
import weakref
from contextvars import ContextVar
from typing import Any

from sqlalchemy import event

logger = logging.getLogger("app.pool_holders")

_scope_var: ContextVar[Any] = ContextVar("pool_holders_scope", default=None)

_FULL_FRACTION = 0.8
_REPORT_HOLDERS = 5


def _app_frame_text(frame: Any) -> "str | None":
    """«app/…py:123 func» for a frame under the app tree (not a library), else None."""
    fn = frame.f_code.co_filename
    if "site-packages" in fn:
        return None
    i = fn.rfind(_APP_MARK)
    return f"{fn[i + 1:]}:{frame.f_lineno} {frame.f_code.co_name}" if i >= 0 else None


def _checkout_chain(limit: int = 5) -> list[str]:
    """The app frames of the CALLER's stack at checkout, outermost first.

    SQLAlchemy's pool events run inside a greenlet whose own frames stop at the greenlet, and a coroutine that is running has no `cr_await` (CPython answers None for an executing frame),
    so neither the greenlet's frames nor the task's await chain show who is asking. The greenlet's PARENT is parked at its switch: its frame chain (`f_back`) is the real call stack of
    the code that awaited the pool — the endpoint, the service, the helper."""
    out: list[str] = []
    try:
        import greenlet

        g = greenlet.getcurrent()
        frame = g.parent.gr_frame if getattr(g, "parent", None) is not None else sys._getframe()
        for _ in range(250):
            if frame is None:
                break
            text = _app_frame_text(frame)
            if text:
                out.append(text)
            frame = frame.f_back
    except Exception:  # noqa: BLE001
        pass
    out.reverse()  # outermost first; the last ones are the innermost
    return out[-limit:]


def _suspended_frames(task: "asyncio.Task | None") -> list[Any]:
    """The frames of a SUSPENDED task's await chain, outermost first (follows cr_await / gi_yieldfrom / ag_await). `Task.get_stack()` is not enough: it returns only the outermost coroutine."""
    frames: list[Any] = []
    if task is None:
        return frames
    try:
        obj = task.get_coro()
        for _ in range(80):
            if obj is None:
                break
            frame = getattr(obj, "cr_frame", None) or getattr(obj, "gi_frame", None) or getattr(obj, "ag_frame", None)
            if frame is not None:
                frames.append(frame)
            obj = getattr(obj, "cr_await", None) or getattr(obj, "gi_yieldfrom", None) or getattr(obj, "ag_await", None)
    except Exception:  # noqa: BLE001
        pass
    return frames


_MAX_TRACKED = 5000
_APP_MARK = "/app/"  # only frames under this path segment are kept in an await chain (a test points it at its own directory)


class _Holder:
    __slots__ = ("since", "task", "had_task", "scope", "record", "chain", "conn_id", "conn_ids")

    def __init__(self, record: Any, task: "asyncio.Task | None", scope: Any, conn_id: int, extra_ids: tuple = ()) -> None:
        self.since = time.monotonic()
        self.task = weakref.ref(task) if task is not None else None
        self.had_task = task is not None  # a task that finished AND was collected leaves a dead weakref: that is a leak too, not «no task»
        self.scope = scope
        self.record = weakref.ref(record)
        self.chain = _checkout_chain()  # where it was checked out — text only, no reference to the task or the frames
        self.conn_id = conn_id
        self.conn_ids = (conn_id, *extra_ids)  # SQLAlchemy's GC line prints the DRIVER connection inside the pooled one (its address), so both are keys


class _Pool:
    def __init__(self, name: str, engine: Any, age_rule: bool = True) -> None:
        self.name = name
        self.engine = engine
        self.age_rule = age_rule  # False: a connection held for long is NORMAL here (the worker pool's advisory-lock connection) — only «nearly full» is worth a line
        self.holders: dict[int, _Holder] = {}
        self.by_conn: dict[int, _Holder] = {}  # id(dbapi connection) → holder, for the garbage-collector line (the log argument is the connection object)


_pools: "dict[str, _Pool]" = {}


class PoolHolderScopeMiddleware:
    """Pure ASGI (BaseHTTPMiddleware runs the handler in another task and the contextvar would not reach it): keeps the request's scope in a contextvar so a
    checkout made while handling it can say which route it belongs to."""

    def __init__(self, app) -> None:  # noqa: ANN001
        self.app = app

    async def __call__(self, scope, receive, send):  # noqa: ANN001
        if scope.get("type") not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        token = _scope_var.set(scope)
        try:
            await self.app(scope, receive, send)
        finally:
            try:
                _scope_var.reset(token)
            except ValueError:  # reset from another context (a streaming body finished elsewhere) — the var dies with its context anyway
                pass


def install(engine: Any, name: str, *, age_rule: bool = True) -> None:
    """Listen to this engine's pool. Idempotent per engine name. Fail-open.

    `age_rule=False` for a pool whose connections are MEANT to be held long (the worker pool: the L2 trigger worker's advisory-lock connection stays for the process's life): the
    «held longer than pool_holder_warn_sec» rule is left out for it, so it does not write a line every poll forever; it still reports when it is nearly full."""
    try:
        from app.core.config import settings

        if not settings.pool_holder_watch_enabled or name in _pools:
            return
        pool = _Pool(name, engine, age_rule)
        _pools[name] = pool
        sync_engine = engine.sync_engine

        def _checkout(dbapi_connection, connection_record, connection_proxy):  # noqa: ANN001
            try:
                try:
                    task = asyncio.current_task()
                except RuntimeError:
                    task = None
                inner = getattr(dbapi_connection, "_connection", None)
                h = _Holder(connection_record, task, _scope_var.get(), id(dbapi_connection), (id(inner),) if inner is not None else ())
                prev = pool.holders.get(id(connection_record))
                if prev is not None:  # the record is being handed out again without a checkin in between (SQLAlchemy's GC path terminates the connection and reuses the record)
                    for cid in prev.conn_ids:
                        pool.by_conn.pop(cid, None)
                pool.holders[id(connection_record)] = h
                for cid in h.conn_ids:
                    pool.by_conn[cid] = h
                if len(pool.holders) > _MAX_TRACKED:  # a runaway leak must not also grow this map without bound
                    for k in list(pool.holders)[: _MAX_TRACKED // 2]:
                        old = pool.holders.pop(k, None)
                        if old is not None:
                            for cid in old.conn_ids:
                                pool.by_conn.pop(cid, None)
            except Exception:  # noqa: BLE001
                pass

        def _checkin(dbapi_connection, connection_record):  # noqa: ANN001
            try:
                h = pool.holders.pop(id(connection_record), None)
                if h is not None:
                    for cid in h.conn_ids:
                        pool.by_conn.pop(cid, None)
            except Exception:  # noqa: BLE001
                pass

        def _invalidate(dbapi_connection, connection_record, exception):  # noqa: ANN001
            _log_invalidation(pool, dbapi_connection, connection_record, exception)

        event.listen(sync_engine, "checkout", _checkout)
        event.listen(sync_engine, "checkin", _checkin)
        event.listen(sync_engine, "invalidate", _invalidate)
        _attach_gc_filter(engine)
    except Exception:  # noqa: BLE001
        logger.warning("pool_holders.install failed for %s", name, exc_info=True)


_GC_MARK = "non-checked-in connection"
_ADDR = re.compile(r"object at (0x[0-9a-fA-F]+)")
_filtered: "set[str]" = set()


class _GcLineFilter(logging.Filter):
    """Adds, to SQLAlchemy's «garbage collector is trying to clean up non-checked-in connection <conn>» line, where that connection was checked out."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
            if _GC_MARK not in msg:
                return True
            # SQLAlchemy formats this line itself (args empty) and prints the driver connection's repr: `<AdaptedConnection <asyncpg.connection.Connection object at 0x…>>`
            ids = {int(x, 16) for x in _ADDR.findall(msg)}
            if isinstance(record.args, tuple):
                ids |= {id(a) for a in record.args}
            for pool in _pools.values():
                h = next((pool.by_conn[i] for i in ids if i in pool.by_conn), None)
                if h is not None:
                    task = h.task() if h.task is not None else None
                    where = " ← ".join(reversed(h.chain)) if h.chain else "no app frame"
                    record.msg = f"{msg} | pool_holders: pool={pool.name} held_for={int(time.monotonic() - h.since)}s {_route_of(h.scope)} checked out at: {where}" + (" (task finished)" if h.had_task and (task is None or task.done()) else "")
                    record.args = ()
                    break
        except Exception:  # noqa: BLE001
            pass
        return True


def _attach_gc_filter(engine: Any) -> None:
    """The pool's class logger (SQLAlchemy names it `<module>.<class>`, e.g. sqlalchemy.pool.impl.AsyncAdaptedQueuePool) — one filter per logger name."""
    for cls in type(engine.pool).__mro__:
        name = f"{cls.__module__}.{cls.__name__}"
        if not name.startswith(("sqlalchemy.pool", "app.")) or name in _filtered:
            continue
        _filtered.add(name)
        logging.getLogger(name).addFilter(_GcLineFilter())


def _sweep_by_conn(pool: _Pool) -> None:
    """by_conn must never hold a holder that is no longer in `holders` (it would keep the scope and the chain alive for good)."""
    live = {id(h) for h in pool.holders.values()}
    for cid, h in list(pool.by_conn.items()):
        if id(h) not in live:
            pool.by_conn.pop(cid, None)


def _prune(pool: _Pool) -> None:
    """A record that is checked in (its fairy is gone) or was dropped is not a holder, whatever happened to the checkin event (an invalidated connection)."""
    for key, h in list(pool.holders.items()):
        rec = h.record()
        if rec is None or getattr(rec, "fairy_ref", True) is None:
            pool.holders.pop(key, None)
            for cid in h.conn_ids:
                pool.by_conn.pop(cid, None)
    _sweep_by_conn(pool)


_INVALIDATION_LINES_PER_MIN = 20
_inval_window: dict[str, list[float]] = {}


def _log_invalidation(pool: _Pool, dbapi_connection: Any, connection_record: Any, exception: Any) -> None:
    """story #4864 (prod 11-09 08:01Z): «Exception terminating connection … CancelledError: Cancelled via cancel scope … BaseHTTPMiddleware» 19 ms after a POST's 201, then a garbage-collector
    line — and no «Exception during reset» line. SQLAlchemy invalidates (and terminates) a connection when a statement is interrupted by a BaseException such as CancelledError; this says WHICH
    statement: one warning per invalidation (at most 20 a minute per pool) with the exception, the route and age of the holder if it is still known, and the call stack of the code that
    was running — the frames of the greenlet parent, i.e. the code that was awaiting the database when the cancellation hit. Never raises."""
    try:
        if exception is None:
            return
        now = time.monotonic()
        window = [t for t in _inval_window.get(pool.name, []) if now - t < 60.0]
        if len(window) >= _INVALIDATION_LINES_PER_MIN:
            _inval_window[pool.name] = window
            return
        window.append(now)
        _inval_window[pool.name] = window
        h = pool.by_conn.get(id(dbapi_connection)) or pool.holders.get(id(connection_record))
        kind = type(exception).__name__
        note = str(exception)[:100] if isinstance(exception, asyncio.CancelledError) else ""  # a cancellation's reason is a fixed phrase; other exceptions may carry server text — class only
        running = " ← ".join(reversed(_checkout_chain(8))) or "no app frame"
        taken = (" ← ".join(reversed(h.chain)) if h and h.chain else "-")
        logger.warning(
            "pool_holders connection invalidated pool=%s exc=%s%s route=%s held_for=%ss checked out at: %s | running when interrupted: %s",
            pool.name, kind, f"({note})" if note else "", _route_of(h.scope) if h else "-", int(now - h.since) if h else -1, taken, running,
        )
    except Exception:  # noqa: BLE001
        pass


def _route_of(scope: Any) -> str:
    if not isinstance(scope, dict):
        return "-"
    route = scope.get("route")
    path = getattr(route, "path", None) or getattr(route, "path_format", None)
    method = scope.get("method") or scope.get("type") or "-"
    return f"{method} {path}" if path else f"{method} <unrouted>"


def _where(task: "asyncio.Task | None", had_task: bool = False) -> str:
    """Where the holding task is waiting right now: the innermost app frame of its await chain and, when different, the innermost frame of all (e.g. `locks.py:... wait`)."""
    if task is None:
        return "task_gone" if had_task else "no_task"
    if task.done():
        return "task_done"  # the task that took the connection has finished and it was never given back: a leak
    try:
        frames = _suspended_frames(task)
        if not frames:
            return "no_frame"
        last = frames[-1]
        short_last = f"{last.f_code.co_filename.rsplit('/', 1)[-1]}:{last.f_lineno} {last.f_code.co_name}"
        app = next((t for t in (_app_frame_text(f) for f in reversed(frames)) if t), None)
        return f"{app} (in {short_last})" if app and app != short_last else (app or short_last)
    except Exception:  # noqa: BLE001
        return "unknown"


def snapshot(name: str = "request") -> list[dict]:
    """The holders of one pool, oldest first (tests · the log line)."""
    pool = _pools.get(name)
    if pool is None:
        return []
    _prune(pool)
    now = time.monotonic()
    out = []
    for h in pool.holders.values():
        task = h.task() if h.task is not None else None
        gone = h.had_task and (task is None or task.done())
        out.append({"age": now - h.since, "route": _route_of(h.scope), "at": _where(task, h.had_task), "from": " ← ".join(reversed(h.chain)) or "-", "leak": bool(gone)})
    out.sort(key=lambda r: r["age"], reverse=True)
    return out


def _capacity(engine: Any) -> tuple[int, int]:
    pool = engine.pool
    try:
        cap = int(pool.size()) + max(int(getattr(pool, "_max_overflow", 0)), 0)
        return int(pool.checkedout()), cap
    except Exception:  # noqa: BLE001
        return 0, 0


def report_lines(warn_sec: float) -> list[str]:
    """One line per pool that has something worth saying; [] when all is calm."""
    lines = []
    for name, pool in _pools.items():
        try:
            held = snapshot(name)
            out, cap = _capacity(pool.engine)
            old = [r for r in held if r["age"] >= warn_sec] if pool.age_rule else []
            near_full = cap > 0 and out >= cap * _FULL_FRACTION
            if not old and not near_full:
                continue
            top = "; ".join(f"age={int(r['age'])}s {r['route']} now at {r['at']} (checked out at {r['from']})" for r in held[:_REPORT_HOLDERS])
            leaks = sum(1 for r in held if r["leak"])
            lines.append(
                f"pool_holders pool={name} checked_out={out}/{cap} held_over_{int(warn_sec)}s={len(old)} leaked={leaks} oldest=[{top}]"
            )
        except Exception:  # noqa: BLE001
            logger.warning("pool_holders report failed for %s", name, exc_info=True)
    return lines


async def watch() -> None:
    """Runs until cancelled. A line is logged at most once per poll and pool; a calm pool logs nothing."""
    from app.core.config import settings

    poll = max(int(settings.pool_holder_poll_sec), 1)
    warn = max(int(settings.pool_holder_warn_sec), 1)
    while True:
        await asyncio.sleep(poll)
        try:
            for line in report_lines(warn):
                logger.warning(line)
        except Exception:  # noqa: BLE001
            logger.warning("pool_holders watch tick failed", exc_info=True)


def start_watch() -> "asyncio.Task | None":
    try:
        from app.core.config import settings

        if not settings.pool_holder_watch_enabled:
            return None
        return asyncio.create_task(watch(), name="pool_holders_watch")
    except Exception:  # noqa: BLE001
        logger.warning("pool_holders.start_watch failed", exc_info=True)
        return None
