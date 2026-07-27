"""story #2193(2026-07-27) — GET /api/v2/docs 응답(DocSummaryResponse)에 created_at이
빠져 있었다(updated_at만 노출) — 문서 트리 시간 그룹의 기준이 생성일이어야 한다는 판단
(오르테가군: 수정일 기준이면 에이전트가 방금 건드린 문서가 위로 오는 「거짓 최신성」이
된다). DB 컬럼은 이미 있다(TimestampMixin) — additive로 노출만 한다.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed(session):
    from app.models.doc import Doc
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    created_ts = datetime.now(timezone.utc) - timedelta(days=3)
    updated_ts = datetime.now(timezone.utc)
    doc = Doc(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="D1",
        slug="d1", doc_type="page",
        created_at=created_ts, updated_at=updated_ts,
    )
    session.add(doc)
    await session.commit()

    return {"org_id": org.id, "project_id": project.id, "doc_id": doc.id, "created_ts": created_ts}


async def test_doc_summary_response_exposes_created_at_distinct_from_updated_at():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            from app.repositories.doc import DocRepository
            from app.routers.docs import list_docs

            repo = DocRepository(s, seeded["org_id"])
            result = await list_docs(
                project_id=seeded["project_id"], parent_id=None, doc_type=None,
                tags=None, slug=None, q=None, limit=500, repo=repo,
            )
        assert len(result) == 1
        summary = result[0]
        assert hasattr(summary, "created_at"), "DocSummaryResponse에 created_at 필드가 없음"
        assert summary.created_at is not None
        assert summary.created_at != summary.updated_at, (
            "created_at이 updated_at과 같은 값이면 시딩이 의도(3일 전 생성·방금 수정)를 못 나타낸 것"
        )
    finally:
        await engine.dispose()
