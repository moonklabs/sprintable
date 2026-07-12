"""E-SECURITY (유휴방지 MEDIUM 상환) — participation add/list story-project scope IDOR, 실 PG.

갭: add_participation(write)·list_participation(read) 둘 다 story_id를 접근권 검증 0으로 받아
(1) 임의 story에 participation(멤버-역할 배정) 주입(cross-project/org write-path IDOR·body-claimed)
(2) 임의 story의 participation 로스터 열람(read exposure)이 가능했다. _KNOWN_DEBT baseline MEDIUM
2건(add/list). fix: story_id→story.project_id(Story.org_id 스코프) 해소 후 resource-actual
has_project_access(404·존재 비노출). add/list 동일 가드.

참고(add_feedback org-level 교훈): Story.project_id는 NOT NULL(모든 story는 project 소속·org-level
story 없음)이라 가드가 항상 project를 해소한다 — None/org-level 분기 없음.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]

_SECRET_MEMBER_ID = uuid.uuid4()


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
    """org(project_a·project_b) + story_a(project_a)·story_b(project_b) + ParticipationRole +
    story_b에 시크릿 participation(로스터 노출 감시) + caller(project_a에만 grant)."""
    from app.models.organization import Organization
    from app.models.participation import Participation, ParticipationRole
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
    story_a = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, title="Story A")
    story_b = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, title="Story B")
    session.add_all([story_a, story_b])
    await session.commit()
    role = ParticipationRole(id=uuid.uuid4(), org_id=org.id, key="reviewer", label="Reviewer")
    session.add(role)
    await session.commit()
    # story_b(무접근)에 시크릿 participation — list 노출 감시 + cross-project delete 대상.
    partic_b_id = uuid.uuid4()
    session.add(Participation(
        id=partic_b_id, org_id=org.id, story_id=story_b.id, member_id=_SECRET_MEMBER_ID, role_id=role.id,
    ))
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
        "org_id": org.id, "story_a_id": story_a.id, "story_b_id": story_b.id,
        "role_id": role.id, "caller_id": caller_id, "partic_b_id": partic_b_id,
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
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {"org_id": str(org_id)}})

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


async def _partic_count(Session, org_id, story_id):
    from sqlalchemy import text
    async with Session() as s:
        return (await s.execute(
            text("SELECT count(*) FROM participation WHERE org_id=:o AND story_id=:s"),
            {"o": org_id, "s": story_id},
        )).scalar_one()


@pytest.mark.anyio
async def test_add_participation_own_story_201():
    """회귀0: project_a grant caller가 project_a story에 participation 추가 → 201."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/participation", json={
                "story_id": str(seeded["story_a_id"]),
                "member_id": str(uuid.uuid4()),
                "role_id": str(seeded["role_id"]),
            })
            assert resp.status_code == 201, resp.text
            assert await _partic_count(Session, seeded["org_id"], seeded["story_a_id"]) == 1
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_add_participation_cross_project_blocked_404():
    """봉인(write-path IDOR·비-동어반복): 접근권 없는 project_b story에 participation 주입 시도 →
    404 + 미생성(직조회로 project_b participation 개수 불변 확認)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        before = await _partic_count(Session, seeded["org_id"], seeded["story_b_id"])
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/participation", json={
                "story_id": str(seeded["story_b_id"]),
                "member_id": str(uuid.uuid4()),
                "role_id": str(seeded["role_id"]),
            })
            assert resp.status_code == 404, resp.text
            assert await _partic_count(Session, seeded["org_id"], seeded["story_b_id"]) == before
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_participation_own_story_200():
    """회귀0: 접근권 있는 story_a participation 조회 → 200."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/participation?story_id={seeded['story_a_id']}")
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_participation_cross_project_blocked_404_no_roster_leak():
    """봉인(read exposure·비-동어반복): 접근권 없는 project_b story의 participation 로스터 조회
    시도 → 404 + 시크릿 participant member_id가 응답 바디에 verbatim 미노출."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/participation?story_id={seeded['story_b_id']}")
            assert resp.status_code == 404, resp.text
            assert str(_SECRET_MEMBER_ID) not in resp.text, "cross-project participation 로스터 유출"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_remove_participation_cross_project_blocked_404_not_deleted():
    """봉인(mutation 대상 project-scope IDOR·5a19b637): project_a grant caller가 접근권 없는
    project_b story의 participation을 id만으로 삭제 시도 → 404 + **미삭제 직조회**(seed된 시크릿
    participation이 그대로 남아있음)."""
    from sqlalchemy import text
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/participation/{seeded['partic_b_id']}")
            assert resp.status_code == 404, resp.text
            # 실제로 삭제 안 됐는지 직조회.
            async with Session() as s2:
                cnt = (await s2.execute(
                    text("SELECT count(*) FROM participation WHERE id = :i"),
                    {"i": seeded["partic_b_id"]},
                )).scalar_one()
                assert cnt == 1, "cross-project participation이 삭제됨(IDOR)"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_remove_participation_own_story_200():
    """회귀0: 접근권 있는 story_a participation은 정상 삭제(200)."""
    import uuid as _uuid
    from sqlalchemy import text
    from app.main import app
    from app.models.participation import Participation
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
            partic_a_id = _uuid.uuid4()
            s.add(Participation(
                id=partic_a_id, org_id=seeded["org_id"], story_id=seeded["story_a_id"],
                member_id=_uuid.uuid4(), role_id=seeded["role_id"],
            ))
            await s.commit()
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/participation/{partic_a_id}")
            assert resp.status_code == 200, resp.text
            async with Session() as s2:
                cnt = (await s2.execute(
                    text("SELECT count(*) FROM participation WHERE id = :i"), {"i": partic_a_id}
                )).scalar_one()
                assert cnt == 0
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
