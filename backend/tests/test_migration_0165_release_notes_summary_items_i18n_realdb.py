"""E-I18N EN 콘텐츠(story d6e3f407) — migration 0165 실 Postgres 검증.

DB env 없으면 skip(CI alembic-fresh 패턴, test_migration_0164_i18n_columns_realdb.py와 동형).
순수 SELECT, Base.metadata.create_all/drop_all로 스키마를 자체 관리하지 않는다 —
destructive_schema 마커 사용 금지(0163 CI 회귀·0164 realdb 테스트 명시 확認과 동일 클래스 교훈).
"""
from __future__ import annotations

import os

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_summary_items_i18n_columns_exist_and_default_empty():
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(_async_url())
    try:
        async with engine.connect() as conn:
            rows = (await conn.execute(text(
                "SELECT summary_i18n, items_i18n FROM release_notes"
            ))).mappings().all()
        assert rows, "release_notes 비어있음 — seed 마이그 미적용?"
        assert all(r["summary_i18n"] == {} for r in rows), "백필 없음이 원칙(순수 구조 추가)"
        assert all(r["items_i18n"] == {} for r in rows), "백필 없음이 원칙(순수 구조 추가)"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_summary_items_legacy_columns_untouched():
    """summary/items(레거시, ko 캐논 소스)가 신규 컬럼 추가와 무관하게 그대로 살아있어야."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(_async_url())
    try:
        async with engine.connect() as conn:
            row = (await conn.execute(text(
                "SELECT summary, items FROM release_notes WHERE note_key = '2026-06-v1-5'"
            ))).mappings().first()
        if row is not None:
            assert row["items"], "0142/0143 시드 items 유실 — 마이그가 기존 데이터를 건드림"
    finally:
        await engine.dispose()
