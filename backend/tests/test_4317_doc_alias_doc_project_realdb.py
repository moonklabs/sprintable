"""story #4317 — 옛 slug(alias) 문서 조회는 alias의 프로젝트와 **문서의 프로젝트** 둘 다 이 프로젝트여야 한다.

문서가 다른 프로젝트에 있는 alias(지금은 문서를 옮기는 기능이 없어 도달 0 · 불변식을 제품 부재가 지키던 자리)로 slug 상세를 조회하면
돌려주지 않는다(FE는 404). 같은 프로젝트 alias는 지금처럼 지금 문서로. 실DB 쿼리라 mock으로는 못 잡는다 · DB env 없으면 skip.
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

ORG = uuid.UUID("43170000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("43170000-0000-0000-0000-0000000000c1")
OTHER_PROJ = uuid.UUID("43170000-0000-0000-0000-0000000000c2")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _reset(session) -> None:
    for sql in [
        f"DELETE FROM doc_slug_aliases WHERE org_id='{ORG}'",
        f"DELETE FROM docs WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
    ]:
        await session.execute(text(sql))
    await session.commit()


async def _seed(session) -> dict[str, uuid.UUID]:
    await _reset(session)
    for sql in [
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','4317 Org','org-4317','free')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ}','{ORG}','P')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{OTHER_PROJ}','{ORG}','Q')",
    ]:
        await session.execute(text(sql))
    ids = {"here": uuid.uuid4(), "elsewhere": uuid.uuid4()}
    for key, proj, slug in [("here", PROJ, "spec-v2"), ("elsewhere", OTHER_PROJ, "secret-plan")]:
        await session.execute(
            text("INSERT INTO docs (id,org_id,project_id,title,slug,content,content_format) VALUES (:id,:org,:proj,:t,:s,'x','markdown')"),
            {"id": ids[key], "org": ORG, "proj": proj, "t": slug, "s": slug},
        )
    # 같은 프로젝트 alias(정상) · 이 프로젝트 이름공간의 alias인데 문서는 다른 프로젝트(불변식 깨진 모양).
    for old, doc_id in [("spec-v1", ids["here"]), ("old-plan", ids["elsewhere"])]:
        await session.execute(
            text("INSERT INTO doc_slug_aliases (id,org_id,project_id,old_slug,doc_id) VALUES (:id,:org,:proj,:old,:doc)"),
            {"id": uuid.uuid4(), "org": ORG, "proj": PROJ, "old": old, "doc": doc_id},
        )
    await session.commit()
    return ids


@pytest.mark.anyio
async def test_get_by_alias_requires_doc_in_same_project(anyio_backend):
    from app.repositories.doc import DocRepository

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            ids = await _seed(session)
            repo = DocRepository(session, ORG)
            same = await repo.get_by_alias(PROJ, "spec-v1")
            assert same is not None and same.id == ids["here"] and same.slug == "spec-v2"  # 회귀 0
            assert await repo.get_by_alias(PROJ, "old-plan") is None  # 문서가 다른 프로젝트 → 안 돌려줌
            await _reset(session)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_slug_detail_404_shape_for_alias_whose_doc_is_elsewhere(anyio_backend):
    from app.repositories.doc import DocRepository
    from app.routers.docs import list_docs

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            await _seed(session)
            repo = DocRepository(session, ORG)
            kwargs = dict(project_id=PROJ, parent_id=None, doc_type=None, tags=None, q=None, ids=None, limit=500, cursor=None, repo=repo)
            moved = await list_docs(slug="old-plan", **kwargs)
            assert moved["data"] == []  # FE getBySlug → «Doc not found» → 404
            same = await list_docs(slug="spec-v1", **kwargs)
            assert [d.slug for d in same["data"]] == ["spec-v2"]  # 같은 프로젝트 alias는 지금 문서
            await _reset(session)
    finally:
        await engine.dispose()
