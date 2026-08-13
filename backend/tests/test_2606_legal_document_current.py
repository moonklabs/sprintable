"""story #2606: 공개 GET /api/v2/legal/{doc_type} — get_current 계약 고정.

v1 범위(PO 지시, 2026-08-13)는 get_current 하나뿐 — 이력/미래 예약본은 admin(internal-api)
전용. 이 테스트는 (1) 미발행 상태는 404(placeholder를 서버가 지어내지 않는다) (2) 발행되면
그 내용이 그대로 나온다 (3) 새 버전을 append하면 직전 열린 행이 자동으로 닫히고 최신 것만
현재로 보인다 — append-only 버전 이력의 핵심 계약을 실 PG로 검증한다."""
from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


def _fake_request() -> MagicMock:
    """카디르 QA 블로커① 수정(@limiter.limit 추가)의 부작용 — 엔드포인트를 직접 함수 호출
    하는 테스트(FastAPI DI를 안 타는 기존 관례)는 이제 slowapi 래퍼가 요구하는 `request`
    포지셔널 인자도 같이 넘겨야 한다. `Limiter(enabled=not _TESTING)`이 pytest 하에서
    False라 실제 rate-limit 판정 로직은 이 값을 안 건드린다(MagicMock로 충분)."""
    return MagicMock()


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
                await get_current_legal_document(request=_fake_request(), doc_type="terms", locale="ko", db=db)
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
            resp = await get_current_legal_document(request=_fake_request(), doc_type="terms", locale="ko", db=db)
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
            resp = await get_current_legal_document(request=_fake_request(), doc_type="terms", locale="ko", db=db)
            assert resp.content == "v2 content", "새 버전 발행 후에도 옛 값이 보이면 append-only 계약 위반"

        # locale 격리 — en에는 아무것도 없으므로 여전히 404(ko 버전이 새는 것 아님).
        async with Session() as db:
            with pytest.raises(HTTPException) as exc:
                await get_current_legal_document(request=_fake_request(), doc_type="terms", locale="en", db=db)
            assert exc.value.status_code == 404
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
async def test_public_endpoint_reachable_without_auth_header_real_http():
    """카디르 QA 블로커①(2026-08-13): `Depends(rate_limit)`(app.dependencies.rate_limit)이
    내부적으로 `Depends(get_current_user)`를 물어, 이 엔드포인트 자체엔 인가 의존성이 없는데도
    무인증 요청이 401로 튕겼다 — get_current_legal_document를 **직접 함수 호출**하는 위 테스트
    들은 FastAPI 의존성 주입 자체를 안 타서 이 결함을 못 잡았다(정확히 이 결함의 은신처).
    실 ASGI 라우팅(TestClient/AsyncClient+ASGITransport)으로 Authorization 헤더 없이 왕복해
    401이 아님을 고정 — public_docs.py 패턴처럼 SlowAPI IP-키 limiter(app.core.rate_limit.
    limiter)로 교체한 수정의 증거."""
    from httpx import ASGITransport, AsyncClient
    from unittest.mock import AsyncMock, MagicMock

    from app.main import app
    from tests.conftest import override_db_and_read

    result = MagicMock()
    result.scalar_one_or_none.return_value = None  # 미발행 → 404(placeholder 없음)
    session = AsyncMock()
    session.execute = AsyncMock(return_value=result)

    async def _override_db():
        yield session

    # story #2451 guard: raw app.dependency_overrides[get_db] = ... 직접 대입 금지 —
    # override_db_and_read 헬퍼로만 걸어야 get_read_db 동시 배선을 구조적으로 보장한다
    # (이 엔드포인트는 get_read_db를 안 쓰지만, 헬퍼 자체가 그 축과 무관하게 강제되는 규율).
    override_db_and_read(app, _override_db)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            # Authorization 헤더 완전히 없음 — 실사용(비로그인 방문자) 그대로.
            resp = await client.get("/api/v2/legal/terms?locale=ko")
        assert resp.status_code != 401, (
            f"무인증 요청이 401 — rate_limit 의존성이 get_current_user를 끌고 있을 가능성 "
            f"(body={resp.text})"
        )
        assert resp.status_code == 404, "미발행 doc_type은 여전히 404(placeholder 미생성)여야"
    finally:
        app.dependency_overrides.clear()


def test_unknown_doc_type_rejected_without_db_roundtrip():
    """400/404 판정이 DB 왕복 전에 걸러지는지 — invalid doc_type이 CHECK violation(500)으로
    새지 않고 깨끗한 404로 응답해야 한다(공개 엔드포인트라 에러 모양이 내부 스키마를 안 흘림)."""
    from app.routers.legal import _DOC_TYPES, _LOCALES
    assert "terms" in _DOC_TYPES and "privacy" in _DOC_TYPES and "refund_policy" in _DOC_TYPES
    assert "not-a-real-type" not in _DOC_TYPES
    assert {"ko", "en"} == _LOCALES
