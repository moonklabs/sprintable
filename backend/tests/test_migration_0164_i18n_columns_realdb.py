"""E-I18N Phase B(story 11f1087c) — migration 0164 실 Postgres 검증.

DB env 없으면 skip(CI alembic-fresh 패턴, test_release_notes_realdb.py와 동형). 이 테스트는
Base.metadata.create_all/drop_all로 스키마를 자체 관리하지 않는다(순수 SELECT, alembic이
이미 만든 컬럼을 읽기만 함) — destructive_schema 마커 사용 금지(0163 테스트가 CI에서 겪은
"격리 미마이그 DB에 role_templates 자체가 없음" 회귀와 동일 클래스 실수를 여기서 반복하지
않기 위해 명시 확認해뒀다).
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
async def test_role_behaviors_i18n_column_exists_and_is_valid_dict():
    """0164 자체는 순수 구조 추가(마이그 시점 백필 없음)가 원칙 — 컬럼 존재+dict 타입만 여기서
    검증한다. "항상 빈 {}" 단정은 안 함: 후속 마이그(0166, PR2 EN 네이티브 저작)가 의도적으로
    "en" 키를 채우므로, head 기준 실행되는 이 테스트가 그 상태와 모순되면 안 된다(0164가
    스스로 데이터를 안 쓴다는 것과 "미래 마이그가 절대 안 채운다"는 다른 주장 — 후자는 검증
    범위 밖)."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(_async_url())
    try:
        async with engine.connect() as conn:
            rows = (await conn.execute(text(
                "SELECT role_behaviors_i18n FROM role_templates"
            ))).scalars().all()
        assert rows, "role_templates 비어있음 — seed 마이그 미적용?"
        assert all(isinstance(r, dict) for r in rows), "role_behaviors_i18n은 항상 dict(JSONB)여야"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_role_behaviors_legacy_column_untouched():
    """0163이 고친 정직한 ko 텍스트가 role_behaviors_i18n 신설과 무관하게 그대로 살아있어야
    (레거시 Text 컬럼 = ko 캐논 소스, 스키마 마이그가 안 건드림)."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(_async_url())
    try:
        async with engine.connect() as conn:
            stale_count = (await conn.execute(text(
                "SELECT count(*) FROM role_templates WHERE role_behaviors LIKE "
                "'%채용 시점 번들이 처리합니다%'"
            ))).scalar_one()
        assert stale_count == 0
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_release_notes_title_i18n_column_exists():
    """0166(PR2)이 head에선 이미 "en" 키를 채우므로 "항상 빈 {}" 단정은 안 함 — 컬럼 존재+
    dict 타입만 검증(0164 자체 파일: 0164_i18n_translation_columns.py의 upgrade()가 데이터를
    안 쓴다는 건 그 파일 자체로 자명 — server_default '{}'만 추가)."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(_async_url())
    try:
        async with engine.connect() as conn:
            row = (await conn.execute(text(
                "SELECT title, title_i18n FROM release_notes LIMIT 1"
            ))).mappings().first()
        if row is not None:  # release_notes 시드가 없는 환경이면 컬럼 존재만 확認(쿼리 성공 자체가 증거)
            assert isinstance(row["title_i18n"], dict)
    finally:
        await engine.dispose()
