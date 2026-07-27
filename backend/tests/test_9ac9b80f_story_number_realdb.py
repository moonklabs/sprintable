"""story 9ac9b80f(FR·대표요청): 프로젝트별 사람-읽는 sequential #N 채번 — 실 PG.

allocate_story_number(advisory xact lock 기반)의 race-safety·프로젝트별 독립성·
oss_seed 배선·응답 노출·#N 조회 필터를 검증한다."""
from __future__ import annotations

import asyncio
import os
import uuid

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


async def _seed_org_project(session, n_projects: int = 1):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_ids = []
    for _ in range(n_projects):
        project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
        session.add(project)
        await session.commit()
        project_ids.append(project.id)

    return org.id, project_ids


@pytest.mark.anyio
async def test_sequential_numbers_start_at_1_and_increment():
    from app.repositories.story import StoryRepository

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, [project_id] = await _seed_org_project(s)
            repo = StoryRepository(s, org_id)
            first = await repo.create(project_id=project_id, title="A", status="backlog", priority="medium")
            second = await repo.create(project_id=project_id, title="B", status="backlog", priority="medium")
            third = await repo.create(project_id=project_id, title="C", status="backlog", priority="medium")
        assert (first.story_number, second.story_number, third.story_number) == (1, 2, 3)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_different_projects_have_independent_counters():
    from app.repositories.story import StoryRepository

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, [proj_a, proj_b] = await _seed_org_project(s, n_projects=2)
            repo = StoryRepository(s, org_id)
            a1 = await repo.create(project_id=proj_a, title="A1", status="backlog", priority="medium")
            b1 = await repo.create(project_id=proj_b, title="B1", status="backlog", priority="medium")
            a2 = await repo.create(project_id=proj_a, title="A2", status="backlog", priority="medium")
        # 서로 다른 프로젝트는 독립적으로 1부터 채번 — proj_b의 첫 스토리도 #1.
        assert a1.story_number == 1
        assert b1.story_number == 1
        assert a2.story_number == 2
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_concurrent_create_race_safe_no_duplicate_or_gap():
    """산티아고 §스토리: 동시 N개 생성이 advisory xact lock으로 직렬화되어 중복/누락 없는
    연속 번호를 받아야 한다."""
    from app.repositories.story import StoryRepository

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, [project_id] = await _seed_org_project(s)

        N = 8

        async def _create_one(i: int):
            async with Session() as s2:
                repo = StoryRepository(s2, org_id)
                story = await repo.create(
                    project_id=project_id, title=f"Concurrent {i}", status="backlog", priority="medium",
                )
                await s2.commit()
                return story.story_number

        numbers = await asyncio.gather(*[_create_one(i) for i in range(N)])
        assert sorted(numbers) == list(range(1, N + 1)), f"중복/누락 발생: {sorted(numbers)}"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_project_scoped_unique_constraint_enforced_at_db_level():
    """advisory lock을 우회해 동일 (project_id, story_number)를 직접 삽입하면 DB 제약이 막는다
    (allocate_story_number가 깨졌을 때의 최후 방어선)."""
    from sqlalchemy.exc import IntegrityError
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, [project_id] = await _seed_org_project(s)
            s.add(Story(
                id=uuid.uuid4(), org_id=org_id, project_id=project_id, story_number=1,
                title="First", status="backlog", priority="medium",
            ))
            await s.commit()

        async with Session() as s:
            s.add(Story(
                id=uuid.uuid4(), org_id=org_id, project_id=project_id, story_number=1,
                title="Duplicate number", status="backlog", priority="medium",
            ))
            with pytest.raises(IntegrityError):
                await s.commit()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_oss_seed_assigns_sequential_numbers():
    from httpx import ASGITransport, AsyncClient
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.dependencies.database import get_db
    from app.main import app
    from app.models.member import Member
    from app.models.project_access import ProjectAccess

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, [project_id] = await _seed_org_project(s)
            user_id = uuid.uuid4()
            human = Member(id=user_id, org_id=org_id, type="human", name="U")
            s.add(human)
            await s.commit()
            s.add(ProjectAccess(id=uuid.uuid4(), project_id=project_id, member_id=user_id, permission="granted"))
            await s.commit()

        async def _override_db():
            # app.core.database.get_db와 동형으로 yield 後 commit — 안 그러면 라우터가 flush만
            # 하고 커밋 안 된 채 응답, 이후 별도 세션으로 재조회 시 0행으로 보인다.
            async with Session() as s:
                yield s
                await s.commit()

        async def _override_auth():
            return AuthContext(user_id=str(user_id), email=None, claims={"app_metadata": {}})

        async def _override_org():
            return org_id

        app.dependency_overrides[get_db] = _override_db
        app.dependency_overrides[get_current_user] = _override_auth
        app.dependency_overrides[get_verified_org_id] = _override_org
        try:
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
                resp = await c.post(f"/api/v2/oss/seed?project_id={project_id}")
            assert resp.status_code == 200
            assert resp.json()["seeded"] is True
        finally:
            app.dependency_overrides.clear()

        async with Session() as s:
            from sqlalchemy import select
            from app.models.pm import Story
            rows = (await s.execute(
                select(Story).where(Story.project_id == project_id).order_by(Story.story_number)
            )).scalars().all()
        assert [r.story_number for r in rows] == [1, 2, 3]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_response_exposes_story_number_and_filter_lookup_works():
    from httpx import ASGITransport, AsyncClient
    from app.dependencies.auth import AuthContext, get_current_user, get_project_scoped_org_id, get_verified_org_id
    from app.dependencies.database import get_db
    from app.main import app
    from app.models.member import Member
    from app.models.project_access import ProjectAccess

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, [project_id] = await _seed_org_project(s)
            user_id = uuid.uuid4()
            human = Member(id=user_id, org_id=org_id, type="human", name="U")
            s.add(human)
            await s.commit()
            s.add(ProjectAccess(id=uuid.uuid4(), project_id=project_id, member_id=user_id, permission="granted"))
            await s.commit()

        async def _override_db():
            # app.core.database.get_db와 동형으로 yield 後 commit — 안 그러면 라우터가 flush만
            # 하고 커밋 안 된 채 응답, 이후 별도 세션으로 재조회 시 0행으로 보인다.
            async with Session() as s:
                yield s
                await s.commit()

        async def _override_auth():
            return AuthContext(user_id=str(user_id), email=None, claims={"app_metadata": {}})

        async def _override_org():
            return org_id

        app.dependency_overrides[get_db] = _override_db
        app.dependency_overrides[get_current_user] = _override_auth
        app.dependency_overrides[get_verified_org_id] = _override_org
        # list_stories의 _get_repo는 get_verified_org_id가 아닌 get_project_scoped_org_id에
        # 의존(내부적으로 get_verified_org_id를 FastAPI DI 밖에서 직접 함수호출하므로 위 override가
        # 안 먹는다) — 별도로 오버라이드해야 한다.
        app.dependency_overrides[get_project_scoped_org_id] = _override_org
        try:
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
                create_resp = await c.post("/api/v2/stories", json={
                    "project_id": str(project_id), "org_id": str(org_id), "title": "Findable",
                })
                assert create_resp.status_code == 201
                created = create_resp.json()
                assert created["story_number"] == 1

                lookup_resp = await c.get(
                    f"/api/v2/stories?project_id={project_id}&story_number=1"
                )
                assert lookup_resp.status_code == 200
                found = lookup_resp.json()
                assert len(found) == 1
                assert found[0]["id"] == created["id"]

                miss_resp = await c.get(
                    f"/api/v2/stories?project_id={project_id}&story_number=999"
                )
                assert miss_resp.json() == []
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
