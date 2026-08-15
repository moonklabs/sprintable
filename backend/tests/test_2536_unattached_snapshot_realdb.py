"""story #2536(E-FLOW-V4 S4) — 일별 unattached_count 스냅샷 cron 실PG 검증.

⛔monkeypatch.setattr(cron.CRON_SECRET) 패턴 — #2274(story #2072 근본수정) 때 확立된 관례.
직접 대입+복원누락으로 CI 전역 401을 냈던 사고가 재발하지 않게 pytest 자동복원에 맡긴다.
"""
from __future__ import annotations

import json
import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
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


async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.flush()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.flush()
    return org, project


def _cron_request():
    from starlette.requests import Request as StarletteRequest
    return StarletteRequest(scope={
        "type": "http", "headers": [(b"authorization", b"Bearer the-real-secret")],
    })


@pytest.mark.anyio
async def test_unattached_snapshot_endpoint_rejects_missing_auth(monkeypatch):
    """AC — 다른 cron 엔드포인트와 같은 verify_cron() 게이트(새 인증 발명 없음)."""
    from fastapi import HTTPException
    from starlette.requests import Request as StarletteRequest

    import app.routers.cron as cron_module
    from app.routers.cron import unattached_snapshot_cron

    monkeypatch.setattr(cron_module, "CRON_SECRET", "the-real-secret")

    request = StarletteRequest(scope={"type": "http", "headers": []})
    with pytest.raises(HTTPException) as exc_info:
        await unattached_snapshot_cron(request, session=None)
    assert exc_info.value.status_code == 401


@pytest.mark.anyio
async def test_unattached_snapshot_counts_match_unattached_clause(monkeypatch):
    """⭐핵심 — _unattached_clause()가 실제로 세는 것과 스냅샷 count가 정확히 일치해야
    한다(정의가 두 곳에서 갈라지면 스파크라인이 거짓말을 한다). epic 부착 1건·hypothesis
    링크 부착 1건·완전 미매달림 2건을 심어 count=2를 확認."""
    from sqlalchemy import select

    import app.routers.cron as cron_module
    from app.models.hypothesis import Hypothesis, HypothesisStoryLink
    from app.models.pm import Goal, Story
    from app.models.unattached_snapshot import UnattachedStorySnapshot
    from app.routers.cron import unattached_snapshot_cron

    monkeypatch.setattr(cron_module, "CRON_SECRET", "the-real-secret")

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project = await _seed_org_project(session)

            goal = Goal(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="G")
            session.add(goal)
            await session.flush()

            story_with_epic = Story(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id,
                title="attached-via-epic", epic_id=goal.id,
            )
            story_with_hyp = Story(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id,
                title="attached-via-hypothesis",
            )
            unattached_1 = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="unattached-1")
            unattached_2 = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="unattached-2")
            session.add_all([story_with_epic, story_with_hyp, unattached_1, unattached_2])
            await session.flush()

            hyp = Hypothesis(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id,
                owner_member_id=uuid.uuid4(), statement="S",
                metric_definition={"metric": "m", "source": "db", "target": 1, "direction": "increase"},
                measure_after=__import__("datetime").datetime(2026, 1, 1, tzinfo=__import__("datetime").UTC),
            )
            session.add(hyp)
            await session.flush()
            session.add(HypothesisStoryLink(
                id=uuid.uuid4(), hypothesis_id=hyp.id, story_id=story_with_hyp.id,
            ))
            await session.commit()

            resp = await unattached_snapshot_cron(_cron_request(), session=session)
            body = json.loads(resp.body)
            assert body["error"] is None
            row = next(r for r in body["data"]["results"] if r["project_id"] == str(project.id))
            assert row["unattached_count"] == 2, (
                f"epic 부착·hypothesis 부착 각 1건은 빠지고 미매달림 2건만 세야 하는데 "
                f"{row['unattached_count']}건 — _unattached_clause 정의와 어긋남"
            )

            snapshot_rows = (
                await session.execute(
                    select(UnattachedStorySnapshot).where(UnattachedStorySnapshot.project_id == project.id)
                )
            ).scalars().all()
            assert len(snapshot_rows) == 1
            assert snapshot_rows[0].unattached_count == 2
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_unattached_snapshot_is_append_only(monkeypatch):
    """AC — 재실행 시 기존 행을 갱신(upsert)하지 않고 새 행을 추가한다(append-only)."""
    from sqlalchemy import select

    import app.routers.cron as cron_module
    from app.models.pm import Story
    from app.models.unattached_snapshot import UnattachedStorySnapshot
    from app.routers.cron import unattached_snapshot_cron

    monkeypatch.setattr(cron_module, "CRON_SECRET", "the-real-secret")

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project = await _seed_org_project(session)
            session.add(Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="s1"))
            await session.commit()

            await unattached_snapshot_cron(_cron_request(), session=session)
            await unattached_snapshot_cron(_cron_request(), session=session)

            rows = (
                await session.execute(
                    select(UnattachedStorySnapshot).where(UnattachedStorySnapshot.project_id == project.id)
                )
            ).scalars().all()
            assert len(rows) == 2, f"append-only라 2회 실행이면 2행이어야 하는데 {len(rows)}행"
            assert all(r.unattached_count == 1 for r in rows)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_unattached_snapshot_zero_is_recorded_explicitly(monkeypatch):
    """AC — 스토리가 하나도 없거나 전부 부착된 프로젝트도 count=0으로 명시 기록한다
    ("아직 미매달림 없음"과 "측정 안 됨"을 구분 — 프로젝트를 아예 건너뛰지 않는다)."""
    from sqlalchemy import select

    import app.routers.cron as cron_module
    from app.models.unattached_snapshot import UnattachedStorySnapshot
    from app.routers.cron import unattached_snapshot_cron

    monkeypatch.setattr(cron_module, "CRON_SECRET", "the-real-secret")

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            _org, project = await _seed_org_project(session)
            await session.commit()

            resp = await unattached_snapshot_cron(_cron_request(), session=session)
            body = json.loads(resp.body)
            row = next(r for r in body["data"]["results"] if r["project_id"] == str(project.id))
            assert row["unattached_count"] == 0

            rows = (
                await session.execute(
                    select(UnattachedStorySnapshot).where(UnattachedStorySnapshot.project_id == project.id)
                )
            ).scalars().all()
            assert len(rows) == 1
            assert rows[0].unattached_count == 0
    finally:
        await engine.dispose()
