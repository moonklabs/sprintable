"""mock-session answers for the statements `login` sends about the person's own row (stories 4838 · 4839).

The mocked sign-in tests give `login` a session whose `execute` returns one canned result. `login` now also asks the database a few questions of its own, each in ONE statement:
  - the read under the person's session lock (hash · active · lock-out) — answered «nothing changed since the start of the request»,
  - the failure count (`UPDATE users SET login_fail_count = …+1 … RETURNING`) — answered from the mock user's own count,
  - the second-step failure count (`WITH old AS (…) UPDATE users …`) — answered «not locked before»,
  - the second-step code record (`UPDATE users SET totp_last_timestep … RETURNING users.id`) — answered «recorded» unless the mock user already used that step or a later one.
Every other statement goes to whatever the test set up. `session.hash_rereads` counts the reads under the lock, so a test of the sign-in road can assert that it happened.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock


def answer_login_rows(session, user) -> None:
    inner = session.execute
    session.hash_rereads = 0
    counted = {"n": int(getattr(user, "login_fail_count", 0) or 0)}

    async def execute(stmt, *args, **kwargs):
        cols = [c.name for c in getattr(stmt, "selected_columns", [])]
        if cols == ["hashed_password", "is_active", "login_locked_until"]:
            session.hash_rereads += 1
            result = MagicMock()
            result.one_or_none.return_value = SimpleNamespace(hashed_password=user.hashed_password, is_active=True, login_locked_until=None)
            return result
        sql = str(stmt)
        if sql.startswith("UPDATE users SET login_fail_count") and "RETURNING" in sql:
            counted["n"] += 1
            locked = datetime.now(timezone.utc) + timedelta(minutes=5) if counted["n"] >= 5 else None
            result = MagicMock()
            result.one.return_value = SimpleNamespace(login_fail_count=counted["n"], login_locked_until=locked)
            return result
        if sql.startswith("WITH old AS"):
            result = MagicMock()
            result.one.return_value = SimpleNamespace(already_locked=False, locked_until=None)
            return result
        if sql.startswith("UPDATE users SET totp_last_timestep") and "RETURNING" in sql:
            step = stmt.compile().params.get("totp_last_timestep_1")
            last = getattr(user, "totp_last_timestep", None)
            result = MagicMock()
            result.first.return_value = None if (last is not None and step is not None and step <= last) else SimpleNamespace(id=user.id)
            return result
        return await inner(stmt, *args, **kwargs)

    session.execute = execute
