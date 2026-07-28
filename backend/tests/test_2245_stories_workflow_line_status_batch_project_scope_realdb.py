"""#2245(형제 비대칭 — 배치판) — GET /workflow-line/status?ids=(stories.py
get_workflow_line_status_batch) project-scope IDOR, 실 PG.

갭: build_workflow_line_status_batch가 org_id + entity_id.in_(ids)로만 필터하고 항목별 project
접근권 검사가 없었다(#2245 PR 리뷰 中 오르테가 지적) — 단건(get_workflow_line_status)과 같은
구멍이나 ids=로 최대 200개를 한 번에 새는 자리라 봉인 값이 더 크다.

처방: has_project_access를 id마다 부르지 않는다(쿼리 200회) — accessible_project_ids_in_org로
접근 가능한 project 집합을 한 번에 구해 조회 前에 story_ids를 거른다. 접근권 없는 id는 조용히
빠지고(부분 성공) 몇 개가 빠졌는지도 알리지 않는다(없는 id와 못 보는 id를 구분하지 않는다).

이 테스트가 오늘 봉인 전체의 대표 증거다 — "섞어 넣어도 남의 것은 안 나온다"가 인가의 본질.
"""
from __future__ import annotations

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


async def _seed(session):
    """org(project_a[caller grant, story 2개]·project_b[무접근, story 2개])."""
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="Project A")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="Project B")
    session.add_all([project_a, project_b])
    await session.commit()

    mine_1 = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, title="Mine 1", status="backlog")
    mine_2 = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, title="Mine 2", status="backlog")
    theirs_1 = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, title="Theirs 1", status="backlog")
    theirs_2 = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, title="Theirs 2", status="backlog")
    session.add_all([mine_1, mine_2, theirs_1, theirs_2])
    await session.commit()

    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(caller_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, org_member_id=caller_om.id, permission="granted", role="member",
    ))
    await session.commit()

    return {
        "org_id": org.id, "caller_id": caller_id,
        "mine_ids": [mine_1.id, mine_2.id], "theirs_ids": [theirs_1.id, theirs_2.id],
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(
            user_id=str(user_id), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


@pytest.mark.anyio
async def test_batch_mixed_ids_returns_only_accessible_no_trace_of_others():
    """본체(대표 증거): 내 project story 2개 + 접근권 없는 project story 2개를 함께 넣으면
    200이면서 내 것만 돌아온다 — 남의 것은 403이 아니라 흔적도 없이 조용히 빠진다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            all_ids = seeded["mine_ids"] + seeded["theirs_ids"]
            resp = await client.get(
                "/api/v2/stories/workflow-line/status",
                params={"ids": ",".join(str(i) for i in all_ids)},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            returned_story_ids = {row["story_id"] for row in body}
            assert returned_story_ids == {str(i) for i in seeded["mine_ids"]}
            for theirs_id in seeded["theirs_ids"]:
                assert str(theirs_id) not in resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_batch_only_accessible_ids_unaffected():
    """회귀 0: 전부 접근권 있는 id만 넣으면 필터링이 아무것도 안 건드리고 그대로 통과."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/stories/workflow-line/status",
                params={"ids": ",".join(str(i) for i in seeded["mine_ids"])},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert {row["story_id"] for row in body} == {str(i) for i in seeded["mine_ids"]}
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
