"""ee7794eb ③: pg_pubsub LISTEN raw URL — DB_PGBOUNCER 時 direct Cloud SQL 우회 + fail-closed 가드.

transaction-mode PgBouncer 는 LISTEN/NOTIFY 미지원 → DB_PGBOUNCER on 이면 raw LISTEN 은 database_url_direct
(direct Cloud SQL)로 가야 한다. on 인데 direct 미설정은 startup fail-closed(silent 이벤트 유실 차단).
"""
from types import SimpleNamespace

import pytest

from app.services.pg_pubsub import _resolve_listen_url, check_listen_config


def _s(database_url, database_url_direct="", db_pgbouncer=False):
    return SimpleNamespace(
        database_url=database_url, database_url_direct=database_url_direct, db_pgbouncer=db_pgbouncer
    )


def test_resolve_uses_direct_when_set():
    # DB_PGBOUNCER on: DATABASE_URL=PgBouncer·LISTEN 은 direct 로.
    s = _s("postgresql+asyncpg://pgb:6432/db", "postgresql+asyncpg://cloudsql/db", db_pgbouncer=True)
    assert _resolve_listen_url(s) == "postgresql://cloudsql/db"  # direct·asyncpg 접두 제거


def test_resolve_falls_back_to_database_url_when_no_direct():
    # non-PgBouncer(off): direct 미설정 → database_url 폴백(현 동작 유지).
    s = _s("postgresql+asyncpg://cloudsql/db")
    assert _resolve_listen_url(s) == "postgresql://cloudsql/db"


def test_check_raises_when_pgbouncer_on_without_direct():
    # fail-closed: on + direct 없음 → raise(LISTEN 깨짐 차단).
    s = _s("postgresql+asyncpg://pgb:6432/db", "", db_pgbouncer=True)
    with pytest.raises(RuntimeError, match="DATABASE_URL_DIRECT"):
        check_listen_config(s)


def test_check_ok_when_pgbouncer_off():
    check_listen_config(_s("postgresql+asyncpg://cloudsql/db"))  # off → no raise


def test_check_ok_when_pgbouncer_on_with_direct():
    check_listen_config(_s("pgb", "direct", db_pgbouncer=True))  # on + direct → no raise
