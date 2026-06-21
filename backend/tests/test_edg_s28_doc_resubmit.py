"""E-DG S28: doc resubmit/revision semantics (안A·같은-doc 재상신).

반려(denied)→수정(denied→draft)→재상신(draft→confirmed re-gate) 흐름. ⭐안A: doc.id/slug stable
유지하고 버전 이력은 DocRevision 타임라인(mockup v1→v2 데이터소스). denied→draft 시 직전(denied) content
스냅샷. superseded_by 는 cross-doc 대체용(재상신 미사용·additive 컬럼). doc-only(hyp 라이프사이클 무관).
"""
from __future__ import annotations

import os
import uuid

import pytest

from app.services.doc import transition_doc

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _session():
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


def _caller(org, type_="human"):
    from app.services.member_resolver import ResolvedMember
    return ResolvedMember(id=uuid.uuid4(), user_id=uuid.uuid4(), name="author",
                          type=type_, role="member", org_id=org)


async def _seed_doc(s, org, status, content="v1 content"):
    from app.models.doc import Doc
    from app.models.project import Project
    proj = uuid.uuid4()
    s.add(Project(id=proj, org_id=org, name="p"))
    await s.flush()
    doc = Doc(org_id=org, project_id=proj, title="d", slug=f"d-{uuid.uuid4().hex[:8]}",
              content=content, status=status)
    s.add(doc)
    await s.flush()
    return doc


# ── DocRevision 스냅샷(denied→draft 재상신 사이클) ───────────────────────────────
@pytest.mark.anyio
async def test_denied_to_draft_snapshots_prior_content():
    """⭐재상신 위한 revise(denied→draft) 시 직전 denied 버전 content 가 DocRevision 에 보존."""
    from app.models.doc import DocRevision
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        doc = await _seed_doc(s, org, status="denied", content="rejected draft body")
        await s.commit()
        await transition_doc(s, org, _caller(org), doc.id, "draft")
        await s.commit()
        revs = (await s.execute(
            select(DocRevision).where(DocRevision.doc_id == doc.id)
        )).scalars().all()
        assert len(revs) == 1
        assert revs[0].content == "rejected draft body"  # denied 버전 보존
        assert revs[0].doc_id == doc.id  # 같은-doc(안A·새 doc 안 만듦)
        refreshed = doc
        assert refreshed.status == "draft"  # 전이 적용됨
    await engine.dispose()


@pytest.mark.anyio
async def test_non_revise_transition_no_snapshot():
    """denied→draft 외 전이(draft→denied)는 스냅샷 안 함(사이클당 1 revision)."""
    from app.models.doc import DocRevision
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        doc = await _seed_doc(s, org, status="draft")
        await s.commit()
        await transition_doc(s, org, _caller(org), doc.id, "denied")  # 반려(스냅샷 아님)
        await s.commit()
        revs = (await s.execute(
            select(DocRevision).where(DocRevision.doc_id == doc.id)
        )).scalars().all()
        assert len(revs) == 0
    await engine.dispose()


@pytest.mark.anyio
async def test_multi_cycle_builds_revision_timeline():
    """재상신 2 사이클 → DocRevision 2개(mockup v1→v2 타임라인)."""
    from app.models.doc import Doc, DocRevision
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        doc = await _seed_doc(s, org, status="denied", content="cycle1")
        await s.commit()
        # 사이클1: denied→draft(snap cycle1) → draft→denied(content 갱신 후 가정)
        await transition_doc(s, org, _caller(org), doc.id, "draft")
        d = (await s.execute(select(Doc).where(Doc.id == doc.id))).scalar_one()
        d.content = "cycle2"
        await s.flush()
        await transition_doc(s, org, _caller(org), doc.id, "denied")
        # 사이클2: denied→draft(snap cycle2)
        await transition_doc(s, org, _caller(org), doc.id, "draft")
        await s.commit()
        revs = (await s.execute(
            select(DocRevision).where(DocRevision.doc_id == doc.id)
            .order_by(DocRevision.created_at)
        )).scalars().all()
        assert [r.content for r in revs] == ["cycle1", "cycle2"]  # 버전 타임라인
    await engine.dispose()
