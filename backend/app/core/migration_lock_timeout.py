"""story #4873 — how long a migration may WAIT for a lock.

Why: `ALTER TABLE` needs ACCESS EXCLUSIVE. If any other connection holds a lock on the table (a transaction left open — prod's idle-in-transaction connections reached 11 for up to 15
minutes), the ALTER queues behind it, and every later reader and writer of that table queues behind the ALTER: on `events` that is every chat delivery. A migration that waits is therefore
not «slow», it is an outage that grows. The deployer runs the migration BEFORE the swap and stops there when it fails (`deploy/vm/bin/deployer.py`: «migrate failed» → `pre-swap` → the old
release keeps serving), so the right behaviour is to FAIL FAST and let the next deploy try again.

`lock_timeout` limits only the WAIT for a lock — not how long a statement runs — so a long index build or backfill is not cut short. 10 seconds: longer than the usual short lock queue, far shorter
than what the app's own request timeouts tolerate before users see errors. `ALEMBIC_LOCK_TIMEOUT_MS` changes it (0 = Postgres' own «no limit», for a maintenance window run by hand).
"""
from __future__ import annotations

import os
from collections.abc import Mapping

DEFAULT_LOCK_TIMEOUT_MS = 10_000
ENV_NAME = "ALEMBIC_LOCK_TIMEOUT_MS"


def migration_lock_timeout_ms(environ: Mapping[str, str] | None = None) -> int:
    raw = (os.environ if environ is None else environ).get(ENV_NAME)
    if raw is None or not raw.strip():
        return DEFAULT_LOCK_TIMEOUT_MS
    try:
        value = int(raw.strip())
    except ValueError:
        raise RuntimeError(f"{ENV_NAME} must be a whole number of milliseconds, got {raw!r}") from None
    if value < 0:
        raise RuntimeError(f"{ENV_NAME} must not be negative, got {value}")
    return value


def apply_lock_timeout(connection, environ: Mapping[str, str] | None = None) -> int:
    """Set the migration connection's `lock_timeout` for the whole session and COMMIT it — a plain `SET` inside a transaction that later rolls back is rolled back with it, and a migration
    that fails is exactly the case that must keep the limit for the next statements. The value is an int checked above, so it is safe to write into the statement."""
    ms = migration_lock_timeout_ms(environ)
    connection.exec_driver_sql(f"SET lock_timeout = {ms}")
    connection.commit()
    return ms
