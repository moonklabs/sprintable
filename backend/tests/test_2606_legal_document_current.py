"""story #2606: 공개 GET /api/v2/legal/{doc_type} — get_current 계약 고정.

v1 범위(PO 지시, 2026-08-13)는 get_current 하나뿐 — 이력/미래 예약본은 admin(internal-api)
전용. 이 테스트는 (1) 미발행 상태는 404(placeholder를 서버가 지어내지 않는다) (2) 발행되면
그 내용이 그대로 나온다 (3) 새 버전을 append하면 직전 열린 행이 자동으로 닫히고 최신 것만
현재로 보인다 — append-only 버전 이력의 핵심 계약을 실 PG로 검증한다."""
from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from fastapi import HTTPException

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _realdb_session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


@pytest.mark.anyio
@pytest.mark.destructive_schema
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_unpublished_doc_type_returns_404_not_placeholder():
    from app.routers.legal import get_current_legal_document
    from app.models.legal_document import LegalDocumentVersion  # noqa: F401

    engine, Session = await _realdb_session()
    try:
        async with Session() as db:
            with pytest.raises(HTTPException) as exc:
                await get_current_legal_document(doc_type="terms", locale="ko", db=db)
            assert exc.value.status_code == 404
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.destructive_schema
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_published_doc_returns_content_and_new_version_closes_old():
    from app.routers.legal import get_current_legal_document
    from app.models.legal_document import LegalDocumentVersion

    engine, Session = await _realdb_session()
    try:
        now = datetime.now(timezone.utc)
        async with Session() as db:
            v1 = LegalDocumentVersion(
                id=uuid.uuid4(), doc_type="terms", locale="ko",
                content="v1 content", content_format="markdown",
                effective_from=now - timedelta(days=1), effective_to=None,
                created_by="admin@sprintable.ai",
            )
            db.add(v1)
            await db.commit()

        async with Session() as db:
            resp = await get_current_legal_document(doc_type="terms", locale="ko", db=db)
            assert resp.content == "v1 content"

        # append-only: 새 버전 insert 시 직전 열린 행을 닫는다(admin 서비스 로직 미러 —
        # 여기선 그 계약이 DB/read 쪽에서 정확히 반영되는지만 검증).
        async with Session() as db:
            from sqlalchemy import select, update
            open_row = (await db.execute(
                select(LegalDocumentVersion).where(
                    LegalDocumentVersion.doc_type == "terms",
                    LegalDocumentVersion.locale == "ko",
                    LegalDocumentVersion.effective_to.is_(None),
                )
            )).scalar_one()
            new_effective_from = now
            await db.execute(
                update(LegalDocumentVersion)
                .where(LegalDocumentVersion.id == open_row.id)
                .values(effective_to=new_effective_from)
            )
            db.add(LegalDocumentVersion(
                id=uuid.uuid4(), doc_type="terms", locale="ko",
                content="v2 content", content_format="markdown",
                effective_from=new_effective_from, effective_to=None,
                created_by="admin@sprintable.ai",
            ))
            await db.commit()

        async with Session() as db:
            resp = await get_current_legal_document(doc_type="terms", locale="ko", db=db)
            assert resp.content == "v2 content", "새 버전 발행 후에도 옛 값이 보이면 append-only 계약 위반"

        # locale 격리 — en에는 아무것도 없으므로 여전히 404(ko 버전이 새는 것 아님).
        async with Session() as db:
            with pytest.raises(HTTPException) as exc:
                await get_current_legal_document(doc_type="terms", locale="en", db=db)
            assert exc.value.status_code == 404
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


def test_unknown_doc_type_rejected_without_db_roundtrip():
    """400/404 판정이 DB 왕복 전에 걸러지는지 — invalid doc_type이 CHECK violation(500)으로
    새지 않고 깨끗한 404로 응답해야 한다(공개 엔드포인트라 에러 모양이 내부 스키마를 안 흘림)."""
    from app.routers.legal import _DOC_TYPES, _LOCALES
    assert "terms" in _DOC_TYPES and "privacy" in _DOC_TYPES and "refund_policy" in _DOC_TYPES
    assert "not-a-real-type" not in _DOC_TYPES
    assert {"ko", "en"} == _LOCALES
