"""story #4741 — a database error's text never reaches a log line, an error event or a response with the values of the row it was about.

Why: the unhandled-exception handler (and any other `logger.exception(...)` / `logger.error("…%s", exc)`) printed `str(exc)`. For a SQLAlchemy error that string is
`<driver message> [SQL: …] [parameters: (…every bound value…)]` — a rejected INSERT/UPDATE put the person's text, a handover draft or a secret-bearing column into the
log (story #4733's Kadir lens: a NUL in a draft line → jsonb refuses it → one ERROR record carried the line). The driver's own message can carry a value too (asyncpg's
client-side «invalid input for query argument $1: '<value>'»; Postgres' «invalid input syntax … "<value>"»).

What this module does, in layers (the engines also set `hide_parameters=True`, which removes the `[parameters: …]` part and the parameters of SQL echo):
- `db_error_summary(exc)` — what is safe and enough to debug: the exception classes, the SQLSTATE, the constraint and table names (identifiers only). No message, no statement, no value.
- `redact_exc_info(exc_info)` — the same exception chain rebuilt with that summary as the text (class names and tracebacks kept), or None when no database error is in it.
- `install_record_redaction()` — a LogRecord factory: every record of every logger is redacted before any handler (Cloud Logging JSON, console, a test's capture) sees it — both the
  `exc_info` and the exception objects passed as `%s` arguments. Records without a database error are left exactly as they were.
"""
from __future__ import annotations

import logging
import re
from types import TracebackType
from typing import Any

from sqlalchemy.exc import DBAPIError, StatementError

_DRIVER_MODULES = ("asyncpg", "psycopg2", "psycopg", "pg8000")
_IDENT = re.compile(r"^[A-Za-z0-9_$.]{1,128}$")
_CHAIN_LIMIT = 8


def _is_db_error(exc: BaseException) -> bool:
    """An error that comes from running a statement: SQLAlchemy's DBAPIError / StatementError (they carry the statement, its parameters and the driver's error), the driver's
    own exceptions and the dialect's adapter exceptions (`sqlalchemy.dialects.*`, whose text quotes the driver's). Configuration / usage errors of SQLAlchemy itself
    (ArgumentError, InvalidRequestError, NoResultFound…) say nothing about a row and keep their words."""
    module = type(exc).__module__
    return isinstance(exc, (DBAPIError, StatementError)) or module.split(".")[0] in _DRIVER_MODULES or module.startswith("sqlalchemy.dialects")


def _chain(exc: BaseException | None) -> list[BaseException]:
    """The exception and what it came from (`__cause__` first, else `__context__`), without loops."""
    out: list[BaseException] = []
    seen: set[int] = set()
    while exc is not None and id(exc) not in seen and len(out) < _CHAIN_LIMIT:
        out.append(exc)
        seen.add(id(exc))
        exc = exc.__cause__ or exc.__context__
    return out


def has_db_error(exc: BaseException | None) -> bool:
    return any(_is_db_error(e) for e in _chain(exc))


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
    chain = _chain(exc)
    db = [e for e in chain if _is_db_error(e)]
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
    """The chain of `exc` rebuilt with every database error replaced by its summary — None when the chain holds none (nothing to hide)."""
    chain = _chain(exc)
    if not any(_is_db_error(e) for e in chain):
        return None
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


def _redact_arg(arg: Any) -> Any:
    return db_error_summary(arg) if isinstance(arg, BaseException) and has_db_error(arg) else arg


def redact_record(record: logging.LogRecord) -> logging.LogRecord:
    if record.exc_info:
        safe = redact_exc_info(record.exc_info)
        if safe is not None:
            record.exc_info = safe
            record.exc_text = None
    if isinstance(record.msg, BaseException):
        record.msg = _redact_arg(record.msg)
    if isinstance(record.args, tuple):
        if any(isinstance(a, BaseException) for a in record.args):
            record.args = tuple(_redact_arg(a) for a in record.args)
    elif isinstance(record.args, dict):
        if any(isinstance(a, BaseException) for a in record.args.values()):
            record.args = {k: _redact_arg(v) for k, v in record.args.items()}
    return record


_INSTALLED = "_db_error_redacting"


def install_record_redaction() -> None:
    """Wrap the LogRecord factory once (idempotent): every record is redacted at its creation, before any handler."""
    current = logging.getLogRecordFactory()
    if getattr(current, _INSTALLED, False):
        return

    def factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
        return redact_record(current(*args, **kwargs))

    setattr(factory, _INSTALLED, True)
    logging.setLogRecordFactory(factory)
