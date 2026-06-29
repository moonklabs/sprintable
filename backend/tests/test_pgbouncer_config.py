"""PgBouncer ④: DB_PGBOUNCER flag 분기 검증.

engine은 import-time 단일 생성이라 flag별 재생성이 어렵다 → 분기 로직을
database._build_engine_kwargs()로 추출해 settings 토글 → 인자 검증으로 커버한다.

- off(기본): pool_size=3/overflow=1(rollout-safe·앱최소 4·ee7794eb) + connect_args 비움(statement_cache_size 없음)
- on:        pool_size=2/overflow=1 + connect_args={"statement_cache_size": 0}
"""
from __future__ import annotations

from app.core.config import Settings
from app.core.database import _build_engine_kwargs
from app.core import database


def test_settings_defaults_flag_off():
    s = Settings()
    assert s.db_pgbouncer is False
    assert s.db_pgbouncer_pool_size == 2
    assert s.db_pgbouncer_max_overflow == 1
    assert s.db_pool_size == 3  # ee7794eb: rollout-safe·앱최소(≥4=3+1) default
    assert s.db_max_overflow == 1


def test_settings_flag_on_via_env(monkeypatch):
    monkeypatch.setenv("DB_PGBOUNCER", "true")
    s = Settings()
    assert s.db_pgbouncer is True


def test_build_engine_kwargs_flag_off(monkeypatch):
    monkeypatch.setattr(database.settings, "db_pgbouncer", False)
    kw = _build_engine_kwargs()
    assert kw["pool_size"] == database.settings.db_pool_size
    assert kw["max_overflow"] == database.settings.db_max_overflow
    assert kw["pool_pre_ping"] is True
    # off: 캐시 on(#1330 revert) — statement_cache_size 미지정
    assert kw["connect_args"] == {}
    assert "statement_cache_size" not in kw["connect_args"]


def test_build_engine_kwargs_flag_on(monkeypatch):
    monkeypatch.setattr(database.settings, "db_pgbouncer", True)
    kw = _build_engine_kwargs()
    assert kw["pool_size"] == database.settings.db_pgbouncer_pool_size
    assert kw["max_overflow"] == database.settings.db_pgbouncer_max_overflow
    assert kw["pool_pre_ping"] is True
    # on: transaction-mode 호환 — prepared statement 캐시 비활성(#1314 재적용)
    assert kw["connect_args"] == {"statement_cache_size": 0}


def test_imported_engine_uses_default_off():
    """import-time 생성된 engine은 flag off(기본) 풀 크기 그대로."""
    assert database.engine.pool.size() == database.settings.db_pool_size
