"""story 4796 — the gateway's connection pool is configurable (the shared Postgres has a connection budget, deploy/vm/RUNBOOK.md §11) and unchanged when it is not configured (Cloud Run has always run with SQLAlchemy's 5 + 10)."""
from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import Settings


def _engine(options: dict):
    return create_async_engine("postgresql+asyncpg://u:p@h/d", **options)  # builds the pool, opens no connection


def test_unset_means_the_defaults_cloud_run_has_always_run_with(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("SUPPORT_GATEWAY_DB_POOL_SIZE", "SUPPORT_GATEWAY_DB_MAX_OVERFLOW"):
        monkeypatch.delenv(key, raising=False)
    s = Settings()
    assert (s.db_pool_size, s.db_max_overflow) == (None, None)
    assert s.engine_options() == {"pool_pre_ping": True}, "no pool argument at all"
    engine = _engine(s.engine_options())
    assert engine.pool.size() == 5 and engine.pool._max_overflow == 10


def test_the_environment_sets_both_numbers_and_they_reach_the_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPPORT_GATEWAY_DB_POOL_SIZE", "3")
    monkeypatch.setenv("SUPPORT_GATEWAY_DB_MAX_OVERFLOW", "2")
    s = Settings()
    assert s.engine_options() == {"pool_pre_ping": True, "pool_size": 3, "max_overflow": 2}
    engine = _engine(s.engine_options())
    assert engine.pool.size() == 3 and engine.pool._max_overflow == 2, "at most 3 + 2 = 5 connections per instance"


@pytest.mark.parametrize("size,overflow", [(3, None), (None, 2)])
def test_half_a_pool_is_refused_not_guessed(size, overflow) -> None:
    with pytest.raises(RuntimeError, match="must be set together"):
        Settings(db_pool_size=size, db_max_overflow=overflow).engine_options()


@pytest.mark.parametrize("size,overflow", [(0, 2), (-1, 0), (3, -1)])
def test_nonsense_numbers_are_refused(size: int, overflow: int) -> None:
    with pytest.raises(RuntimeError):
        Settings(db_pool_size=size, db_max_overflow=overflow).engine_options()


def test_the_service_engine_is_built_from_these_options_and_keeps_pinging() -> None:
    source = (Path(__file__).resolve().parents[1] / "app/db.py").read_text()
    assert "create_async_engine(settings.database_url, **settings.engine_options())" in source
    assert Settings().engine_options()["pool_pre_ping"] is True
