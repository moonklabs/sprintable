"""E-I18N EN 콘텐츠 PR2(story d6e3f407) — migration 0166 실 Postgres 검증.

DB env 없으면 skip(0164/0165 realdb 패턴과 동형). 순수 SELECT — destructive_schema 마커
사용 금지(0163 CI 회귀 교훈).
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
async def test_all_role_templates_have_en_role_behaviors():
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(_async_url())
    try:
        async with engine.connect() as conn:
            rows = (await conn.execute(text(
                "SELECT slug, role_behaviors_i18n->>'en' AS en FROM role_templates"
            ))).mappings().all()
        assert rows, "role_templates 비어있음 — seed 마이그 미적용?"
        missing = [r["slug"] for r in rows if not r["en"]]
        assert not missing, f"EN role_behaviors 누락: {missing}"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_legacy_ko_role_behaviors_untouched_by_en_backfill():
    """EN 백필이 기존 ko role_behaviors(레거시 캐논 소스)를 안 건드렸는지 — 0163이 고친 정직한
    텍스트가 그대로 살아있어야."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(_async_url())
    try:
        async with engine.connect() as conn:
            stale_count = (await conn.execute(text(
                "SELECT count(*) FROM role_templates WHERE role_behaviors LIKE "
                "'%채용 시점 번들이 처리합니다%'"
            ))).scalar_one()
            ko_count = (await conn.execute(text(
                "SELECT count(*) FROM role_templates WHERE role_behaviors LIKE '%자율 운영 지침%'"
            ))).scalar_one()
        assert stale_count == 0
        assert ko_count == 24
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_all_release_notes_have_en_title_summary_items():
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(_async_url())
    try:
        async with engine.connect() as conn:
            rows = (await conn.execute(text(
                "SELECT note_key, title_i18n->>'en' AS title_en, summary_i18n->>'en' AS summary_en, "
                "items_i18n->'en' AS items_en FROM release_notes"
            ))).mappings().all()
        assert rows, "release_notes 비어있음"
        for r in rows:
            assert r["title_en"], f"{r['note_key']} title_en 누락"
            assert r["summary_en"], f"{r['note_key']} summary_en 누락"
            assert r["items_en"], f"{r['note_key']} items_en 누락"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_compose_kit_en_locale_uses_native_content_for_real_seeded_role():
    """소비 배선(PR1, #1969) + 데이터(PR2, #0166)가 실제로 맞물리는지 — 실 DB row로 compose_kit
    locale="en" 호출, 결과에 legacy ko role_behaviors 텍스트가 안 남아있는지 확인."""
    from types import SimpleNamespace
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from app.services.agent_recruiter import compose_kit

    engine = create_async_engine(_async_url())
    try:
        async with engine.connect() as conn:
            row = (await conn.execute(text(
                "SELECT slug, name, role_behaviors, role_behaviors_i18n, default_tool_groups, "
                "runtime_overrides FROM role_templates WHERE slug = 'backend'"
            ))).mappings().first()
        assert row is not None, "backend role_template 시드 없음"
        role = SimpleNamespace(**dict(row))
        kit = compose_kit(role, "claude-code", locale="en")
        assert "Autonomous Operating Instructions" in kit["role_context"]
        assert row["role_behaviors"] not in kit["role_context"], "ko 레거시 텍스트가 EN 결과에 새어나옴"
    finally:
        await engine.dispose()
