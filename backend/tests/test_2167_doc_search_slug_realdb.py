"""story #2167(2026-07-25, 까심): docs.search_vector에 slug가 포함됐는지 실DB로 검증.

search_vector는 Postgres GENERATED 컬럼(migration 0211)이라 SQLite/mock으로는 이 회귀를 잡을 수
없다 — slug 검색이 다시 깨져도(누가 실수로 컬럼 정의를 되돌려도) mock 테스트는 초록일 것이다.
DB env 없으면 skip(CI alembic-fresh와 동일 관례, test_doc_asset_backfill_realdb.py 참고).
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)
pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("21670000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("21670000-0000-0000-0000-0000000000c1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed(session):
    doc_id = uuid.uuid4()
    for sql in [
        f"DELETE FROM docs WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','2167 Org','org-2167','free')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ}','{ORG}','P')",
    ]:
        await session.execute(text(sql))
    # 슬러그로만 찾아야 하는 문서 — 제목·본문엔 슬러그 단어가 전혀 없다.
    await session.execute(
        text(
            "INSERT INTO docs (id,org_id,project_id,title,slug,content,content_format) "
            "VALUES (:id,:org,:proj,'Onboarding Guide','onboarding-flow-v2',"
            "'How new users get set up.','markdown')"
        ),
        {"id": doc_id, "org": ORG, "proj": PROJ},
    )
    await session.commit()
    return doc_id


@pytest.mark.anyio
async def test_search_full_text_matches_slug(anyio_backend):
    from app.repositories.doc import DocRepository

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    async with Session() as session:
        doc_id = await _seed(session)

        repo = DocRepository(session, ORG)
        # 제목("Onboarding Guide")·본문에는 없는, slug에만 있는 단어로 검색 — RED였다가
        # migration 0211(search_vector에 slug 포함) 이후 GREEN.
        results = await repo.search_full_text(PROJ, "onboarding-flow-v2")
        assert len(results) == 1
        found_doc, _snippet = results[0]
        assert found_doc.id == doc_id
        assert found_doc.slug == "onboarding-flow-v2"

    await engine.dispose()


@pytest.mark.anyio
async def test_search_full_text_title_still_works(anyio_backend):
    """slug 추가가 기존 title/content 매칭을 깨지 않았는지 회귀 확인."""
    from app.repositories.doc import DocRepository

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    async with Session() as session:
        await _seed(session)

        repo = DocRepository(session, ORG)
        results = await repo.search_full_text(PROJ, "Onboarding")
        assert len(results) == 1
        assert results[0][0].title == "Onboarding Guide"

    await engine.dispose()
