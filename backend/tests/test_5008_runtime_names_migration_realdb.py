"""story 5008 (A1) — migration 0497 on a real Postgres: the three desktop relay tables allow the registry's names, it goes down and up again, and a downgrade STOPS rather than delete rows.

The state test reads what `alembic upgrade heads` left (non-destructive bucket, like the other migration tests). The up/down tests run the migration's own functions
inside ONE transaction that is rolled back at the end, so the shared database is never left half-moved.

Red when: a constraint stops carrying a registry name (a registry row added without the migration), the downgrade stops restoring the old names, or the downgrade deletes/hides a row
that names a runtime the old constraint does not know (it must raise and change nothing).
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
pytestmark = pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres needed (PARITY/ALEMBIC_DATABASE_URL) — alembic upgrade heads first")

ROOT = Path(__file__).resolve().parents[1]
CHECKS = (
    ("desktop_sessions", "ck_desktop_sessions_runtime"),
    ("agent_permission_requests", "ck_agent_permission_requests_runtime"),
    ("desktop_usage", "ck_desktop_usage_runtime"),
)


def _migration():
    spec = importlib.util.spec_from_file_location("m0497", ROOT / "alembic/versions/0497_desktop_runtime_names.py")
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _engine():
    from sqlalchemy import create_engine

    url = _REAL_DB_URL or ""
    for prefix in ("postgresql+asyncpg://", "postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+psycopg2://" + url[len(prefix):]
            break
    return create_engine(url)


def _def(conn, table: str, name: str) -> str:
    from sqlalchemy import text

    return conn.execute(
        text("SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = :t AND c.conname = :n"),
        {"t": table, "n": name},
    ).scalar_one()


def _run(conn, fn):
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    with Operations.context(MigrationContext.configure(conn)):
        fn()


def test_after_alembic_upgrade_the_three_constraints_allow_every_registry_name():
    from app.services.agent_runtime import DESKTOP_RUNTIME_IDS

    eng = _engine()
    try:
        with eng.connect() as conn:
            for table, name in CHECKS:
                d = _def(conn, table, name)
                for rid in DESKTOP_RUNTIME_IDS:
                    assert f"'{rid}'" in d, f"{name} does not allow {rid}: {d}"
    finally:
        eng.dispose()


def test_down_restores_the_old_names_and_up_brings_the_new_ones_back():
    m = _migration()
    eng = _engine()
    try:
        with eng.connect() as conn:
            tx = conn.begin()
            try:
                _run(conn, m.downgrade)  # no row names a new runtime on a fresh database
                for table, name in CHECKS:
                    d = _def(conn, table, name)
                    assert "'claude'" in d and "'codex'" in d
                    assert "'opencode'" not in d and "'gemini'" not in d and "'cursor'" not in d
                _run(conn, m.upgrade)
                for table, name in CHECKS:
                    d = _def(conn, table, name)
                    for rid in m._NEW:
                        assert f"'{rid}'" in d
            finally:
                tx.rollback()
    finally:
        eng.dispose()


def test_a_downgrade_stops_and_changes_nothing_when_a_row_names_a_newer_runtime():
    from sqlalchemy import text

    m = _migration()
    eng = _engine()
    try:
        with eng.connect() as conn:
            tx = conn.begin()
            try:
                # a scratch table shaped like the three, holding one row that names a newer runtime (the real tables need a whole computer + member behind a row)
                conn.execute(text("CREATE TEMP TABLE t5008 (runtime text)"))
                conn.execute(text(f"ALTER TABLE t5008 ADD CONSTRAINT ck_t5008 CHECK (runtime IN ({', '.join(repr(v) for v in m._NEW)}))"))
                conn.execute(text("INSERT INTO t5008 VALUES ('claude'), ('opencode')"))
                m._CHECKS = (("t5008", "ck_t5008"),)
                with pytest.raises(RuntimeError) as e:
                    _run(conn, m.downgrade)
                assert "nothing was changed" in str(e.value) and "t5008" in str(e.value)
                assert conn.execute(text("SELECT count(*) FROM t5008")).scalar_one() == 2  # no row was deleted
                assert "'opencode'" in _def(conn, "t5008", "ck_t5008")  # the constraint is the new one still
                conn.execute(text("DELETE FROM t5008 WHERE runtime = 'opencode'"))  # the person moved the row on purpose
                _run(conn, m.downgrade)
                assert "'opencode'" not in _def(conn, "t5008", "ck_t5008")
            finally:
                tx.rollback()
    finally:
        eng.dispose()
