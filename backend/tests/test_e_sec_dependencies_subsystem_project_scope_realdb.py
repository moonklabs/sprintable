"""E-SECURITY 스캐너 #6 서브시스템(story aa365768) — dependencies create/delete/list/graph
project-scope IDOR, 실 PG.

갭: dependency 서브시스템 전체가 project-blind였다(project_id 컬럼 없음·create/delete/list/graph
전부 org-scope만). caller가 접근권 없는 project의 아이템 간 의존성을 생성/삭제하거나(무단 mutation)
그 로스터/그래프를 열람(read exposure)할 수 있었다. fix: 아이템(epic/sprint/story)→project 해소 후
공통 게이트 — create/delete=양쪽 아이템(from+to) 접근권·list=조회 아이템 접근권·graph=응답을
caller-accessible project로 필터(사이클/그래프 계산은 org-wide 보존·설계의도 (a) cross-project 허용).
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


def _story(org_id, project_id, title):
    from app.models.pm import Story
    return Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)


async def _seed(session):
    """org(project_a[caller grant]·project_b[무접근]) + story a1/a2(project_a)·b1/b2(project_b) +
    dep_aa(a1→a2)·dep_bb(b1→b2). item_type=story."""
    from app.models.dependency import ItemDependency
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    pa = Project(id=uuid.uuid4(), org_id=org.id, name="A")
    pb = Project(id=uuid.uuid4(), org_id=org.id, name="B")
    session.add_all([pa, pb])
    await session.commit()
    a1, a2, a3 = _story(org.id, pa.id, "A1"), _story(org.id, pa.id, "A2"), _story(org.id, pa.id, "A3")
    b1, b2 = _story(org.id, pb.id, "B1"), _story(org.id, pb.id, "B2")
    session.add_all([a1, a2, a3, b1, b2])
    await session.commit()
    dep_aa = ItemDependency(id=uuid.uuid4(), org_id=org.id, from_id=a1.id, to_id=a2.id, dep_type="blocks", item_type="story")
    dep_bb = ItemDependency(id=uuid.uuid4(), org_id=org.id, from_id=b1.id, to_id=b2.id, dep_type="blocks", item_type="story")
    session.add_all([dep_aa, dep_bb])
    await session.commit()

    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=pa.id, org_member_id=om.id, permission="granted", role="member",
    ))
    await session.commit()

    return {
        "org_id": org.id, "caller_id": caller_id,
        "a1": a1.id, "a2": a2.id, "a3": a3.id, "b1": b1.id, "b2": b2.id,
        "dep_aa": dep_aa.id, "dep_bb": dep_bb.id,
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


async def _dep_count(Session, dep_id):
    from sqlalchemy import text
    async with Session() as s:
        return (await s.execute(
            text("SELECT count(*) FROM item_dependency WHERE id = :i"), {"i": dep_id}
        )).scalar_one()


# ── create ────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_create_dependency_own_project_201():
    """회귀0: project_a 아이템끼리 의존성 생성 → 201."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/dependencies", json={
                "from_id": str(seeded["a2"]), "to_id": str(seeded["a3"]),
                "dep_type": "blocks", "item_type": "story",
            })
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_dependency_cross_project_blocked_404():
    """봉인: 접근권 없는 project_b 아이템끼리 의존성 생성 시도 → 404(양쪽 무접근)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/dependencies", json={
                "from_id": str(seeded["b1"]), "to_id": str(seeded["b2"]),
                "dep_type": "blocks", "item_type": "story",
            })
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_dependency_mixed_one_inaccessible_blocked_404():
    """봉인(양쪽-아이템 규칙·비-동어반복): from=접근O(a1)·to=접근X(b1) 혼합 → 404(한쪽만 무접근도
    차단). 반쪽 게이트였다면 통과했을 케이스."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/dependencies", json={
                "from_id": str(seeded["a1"]), "to_id": str(seeded["b1"]),
                "dep_type": "blocks", "item_type": "story",
            })
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── delete ────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_delete_dependency_own_project_200():
    """회귀0: project_a 의존성 삭제 → 200."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/dependencies/{seeded['dep_aa']}")
            assert resp.status_code == 200, resp.text
            assert await _dep_count(Session, seeded["dep_aa"]) == 0
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_delete_dependency_cross_project_blocked_404_not_deleted():
    """봉인: 접근권 없는 project_b 의존성 삭제 시도 → 404 + **미삭제 직조회**."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/dependencies/{seeded['dep_bb']}")
            assert resp.status_code == 404, resp.text
            assert await _dep_count(Session, seeded["dep_bb"]) == 1, "cross-project 의존성이 삭제됨(IDOR)"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── list ──────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_list_dependencies_cross_project_blocked_404():
    """봉인(read exposure): 접근권 없는 project_b 아이템의 의존성 로스터 조회 시도 → 404."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/dependencies?item_type=story&item_id={seeded['b1']}")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── graph (AC3: 응답 필터·사이클 org-wide 보존) ─────────────────────────────────

@pytest.mark.anyio
async def test_dependency_graph_filters_inaccessible_project():
    """봉인(graph read-exposure·AC3): org-wide graph 조회 시 응답이 caller-accessible project로
    필터돼 접근권 없는 project_b의 노드(b1/b2)·엣지(dep_bb)가 노출되지 않는다. project_a 것만 보임."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/dependencies/graph?item_type=story")
            assert resp.status_code == 200, resp.text
            body = resp.text
            # project_b 노드는 응답 바디에 verbatim 미노출.
            assert str(seeded["b1"]) not in body, "graph가 접근권 없는 project 노드 노출(exposure)"
            assert str(seeded["b2"]) not in body
            # project_a 노드는 보임(회귀0).
            data = resp.json()
            node_strs = {str(n) for n in data["nodes"]}
            assert str(seeded["a1"]) in node_strs and str(seeded["a2"]) in node_strs
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
