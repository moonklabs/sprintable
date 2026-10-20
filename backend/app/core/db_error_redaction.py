"""story #4741 — a database error's text never reaches a log line, an error event or a response with the values of the row it was about.

Why: the unhandled-exception handler (and any other `logger.exception(...)` / `logger.error("…%s", exc)`) printed `str(exc)`. For a SQLAlchemy error that string is
`<driver message> [SQL: …] [parameters: (…every bound value…)]` — a rejected INSERT/UPDATE put the person's text, a handover draft or a secret-bearing column into the
log (story #4733's Kadir lens: a NUL in a draft line → jsonb refuses it → one ERROR record carried the line). The driver's own message can carry a value too (asyncpg's
client-side «invalid input for query argument $1: '<value>'»; Postgres' «invalid input syntax … "<value>"»).

What this module does, in layers (the engines also set `hide_parameters=True`, which removes the `[parameters: …]` part and the parameters of SQL echo):
- `db_error_summary(exc)` — what is safe and enough to debug: the exception classes, the SQLSTATE, the constraint and table names (identifiers only). No message, no statement, no value.
- `redact_exc_info(exc_info)` — the same exception chain rebuilt with that summary as the text (class names and tracebacks kept), or None when no database error is in it.
- `install_record_redaction()` — a LogRecord factory plus a `Logger.makeRecord` wrapper (for `extra` fields): every record of every logger is redacted before any handler (Cloud Logging JSON, console, a test's capture) sees it — the
  `exc_info`, exception objects passed as `%s` / mapping arguments (also nested in a tuple / list / mapping) and `extra` fields. Records without a database error are left exactly as they were.
"""
from __future__ import annotations

import logging
import re
from types import TracebackType
from typing import Any

from sqlalchemy.exc import DBAPIError, InvalidRequestError, PendingRollbackError, StatementError

_DRIVER_MODULES = ("asyncpg", "psycopg2", "psycopg", "pg8000")
_IDENT = re.compile(r"^[A-Za-z0-9_$.]{1,128}$")
def _is_db_error(exc: BaseException) -> bool:
    """An error that comes from running a statement: SQLAlchemy's DBAPIError / StatementError (they carry the statement, its parameters and the driver's error), the driver's
    own exceptions and the dialect's adapter exceptions (`sqlalchemy.dialects.*`, whose text quotes the driver's). Configuration / usage errors of SQLAlchemy itself
    (ArgumentError, InvalidRequestError, NoResultFound…) say nothing about a row and keep their words."""
    module = type(exc).__module__
    if isinstance(exc, PendingRollbackError) or (isinstance(exc, InvalidRequestError) and "Original exception was" in str(exc)):
        return True  # a session used again after a failed flush: its text quotes the ORIGINAL database error («Original exception was: …»)
    return isinstance(exc, (DBAPIError, StatementError)) or module.split(".")[0] in _DRIVER_MODULES or module.startswith("sqlalchemy.dialects")


_GRAPH_LIMIT = 50


def _children(exc: BaseException) -> list[BaseException]:
    """What an exception came from: its cause, its context, and the members of an ExceptionGroup."""
    out: list[BaseException] = []
    for child in (exc.__cause__, exc.__context__, *getattr(exc, "exceptions", ())):
        if isinstance(child, BaseException):
            out.append(child)
    return out


def _walk(exc: BaseException | None) -> list[BaseException]:
    """The exception and everything it came from — causes, contexts and group members, each once, breadth first, bounded."""
    out: list[BaseException] = []
    seen: set[int] = set()
    queue = [exc] if exc is not None else []
    while queue and len(out) < _GRAPH_LIMIT:
        cur = queue.pop(0)
        if id(cur) in seen:
            continue
        seen.add(id(cur))
        out.append(cur)
        queue.extend(_children(cur))
    return out


def _linear_chain(exc: BaseException) -> list[BaseException] | None:
    """The chain `exc → cause (or context) → …` when every link has exactly one way back, else None (a branch or a group)."""
    out: list[BaseException] = []
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None:
        if id(cur) in seen or len(out) >= _GRAPH_LIMIT:
            return None
        seen.add(id(cur))
        out.append(cur)
        kids = _children(cur)
        distinct = {id(k) for k in kids}
        if len(distinct) > 1 or getattr(cur, "exceptions", ()):
            return None
        cur = kids[0] if kids else None
    return out


def has_db_error(exc: BaseException | None) -> bool:
    return any(_is_db_error(e) for e in _walk(exc))


def _attr(objs: list[Any], *names: str) -> str | None:
    for obj in objs:
        for name in names:
            value = getattr(obj, name, None)
            if isinstance(value, str) and _IDENT.match(value):
                return value
    return None


def db_error_summary(exc: BaseException) -> str:
    """`ProgrammingError[CharacterNotInRepertoireError] sqlstate=22021` / `IntegrityError[UniqueViolationError] sqlstate=23505 constraint=uq_x table=t` — classes, SQLSTATE and
    identifier names only. Never the message, the statement or a value."""
    db = [e for e in _walk(exc) if _is_db_error(e)]
    objs: list[Any] = []
    for e in db:
        orig = getattr(e, "orig", None)
        objs += [e, orig, getattr(orig, "__cause__", None)]
    classes = [type(e).__name__ for e in db][:3]
    head = classes[0] + (f"[{'/'.join(dict.fromkeys(classes[1:]))}]" if len(classes) > 1 else "")
    parts = [head]
    for label, names in (("sqlstate", ("sqlstate", "pgcode")), ("constraint", ("constraint_name",)), ("table", ("table_name",))):
        value = _attr(objs, *names)
        if value:
            parts.append(f"{label}={value}")
    return " ".join(parts)


def _rebuilt(exc: BaseException) -> BaseException:
    """The same class NAME (so stack grouping and reading stay), a safe text, the original traceback."""
    text = db_error_summary(exc) if _is_db_error(exc) else str(exc)
    clone = type(type(exc).__name__, (Exception,), {"__module__": type(exc).__module__})(text)
    return clone.with_traceback(exc.__traceback__)


def redact_exception(exc: BaseException) -> BaseException | None:
    """`exc` rebuilt so that no database error's words remain — None when nothing in what it came from is one. A plain chain keeps its shape (every link its class name and its
    text, a database link its safe summary); a branch or an ExceptionGroup is flattened to ONE exception of the top class carrying the summary (nothing of the members' texts)."""
    if not has_db_error(exc):
        return None
    chain = _linear_chain(exc)
    if chain is None:
        flat = type(type(exc).__name__, (Exception,), {"__module__": type(exc).__module__})(db_error_summary(exc))
        return flat.with_traceback(exc.__traceback__)
    rebuilt = [_rebuilt(e) for e in chain]
    for newer, older in zip(rebuilt, rebuilt[1:]):
        newer.__cause__ = older
        newer.__suppress_context__ = True
    return rebuilt[0]


def redact_exc_info(exc_info: Any) -> Any:
    if not (isinstance(exc_info, tuple) and len(exc_info) == 3 and isinstance(exc_info[1], BaseException)):
        return None
    clone = redact_exception(exc_info[1])
    if clone is None:
        return None
    tb: TracebackType | None = exc_info[2]
    return (type(clone), clone, tb)


def safe_exception_text(exc: BaseException) -> str:
    """The text of an exception for a place that stores or returns it (an error event row, a response): the safe summary when a database error is in it, else its own text."""
    return db_error_summary(exc) if has_db_error(exc) else str(exc)


def _redact_arg(arg: Any, depth: int = 0) -> Any:
    """A log argument with every exception that holds a database error replaced by its safe summary — also inside a tuple / list / set / mapping (three levels);
    the same object back when nothing in it changed."""
    if isinstance(arg, BaseException):
        return db_error_summary(arg) if has_db_error(arg) else arg
    if depth >= 3:
        return arg
    if isinstance(arg, (tuple, list, set, frozenset)):
        items = list(arg)
        new = [_redact_arg(a, depth + 1) for a in items]
        return arg if all(n is o for n, o in zip(new, items)) else (tuple(new) if isinstance(arg, tuple) else type(arg)(new))
    if isinstance(arg, dict):
        new_map = {k: _redact_arg(v, depth + 1) for k, v in arg.items()}
        return arg if all(new_map[k] is v for k, v in arg.items()) else new_map
    return arg


def redact_record(record: logging.LogRecord) -> logging.LogRecord:
    if record.exc_info:
        safe = redact_exc_info(record.exc_info)
        if safe is not None:
            record.exc_info = safe
            record.exc_text = None
    if isinstance(record.msg, BaseException):
        record.msg = _redact_arg(record.msg)
    record.args = _redact_arg(record.args) if record.args else record.args
    for key, value in list(record.__dict__.items()):  # `extra={…: exc}` fields (a list / mapping of them too)
        if key not in _RECORD_OWN and isinstance(value, (BaseException, tuple, list, set, frozenset, dict)):
            record.__dict__[key] = _redact_arg(value)
    return record


_RECORD_OWN = frozenset({"msg", "args", "exc_info", "exc_text", "stack_info", "name", "levelname", "levelno", "pathname", "filename", "module", "funcName", "lineno", "created", "msecs",
                         "relativeCreated", "thread", "threadName", "process", "processName", "taskName", "message", "asctime"})
_INSTALLED = "_db_error_redacting"


def install_record_redaction() -> None:
    """Redact at the LogRecord, once (idempotent): the record factory covers every record made through it (`makeLogRecord` included); `Logger.makeRecord` is wrapped as well
    because the standard library copies `extra={…}` into the record AFTER the factory returns — a database error handed over as an extra field would otherwise get past it."""
    current = logging.getLogRecordFactory()
    if not getattr(current, _INSTALLED, False):
        def factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
            return redact_record(current(*args, **kwargs))

        setattr(factory, _INSTALLED, True)
        logging.setLogRecordFactory(factory)
    make_record = logging.Logger.makeRecord
    if not getattr(make_record, _INSTALLED, False):
        def wrapped(self: logging.Logger, *args: Any, **kwargs: Any) -> logging.LogRecord:
            return redact_record(make_record(self, *args, **kwargs))

        setattr(wrapped, _INSTALLED, True)
        logging.Logger.makeRecord = wrapped  # type: ignore[method-assign]
