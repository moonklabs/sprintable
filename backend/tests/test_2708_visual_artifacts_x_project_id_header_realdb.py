"""story #2708 — 아티팩트 갤러리(/artifacts)가 60+건 존재하는데 「No artifacts collected yet」로
빈 화면. 근본원인: `_get_org_project(auth)`가 JWT app_metadata.project_id만 읽고 X-Project-Id
헤더를 아예 몰랐다(파라미터로도 안 받음) — 브라우저가 실제로 보고 있는 프로젝트와 무관하게
JWT에 구워진(다른/기본) project_id로 조용히 스코프해 빈 배열을 냈다(유나 라이브 판별).

처방: visual_artifacts.py 19개 라우트 전부 `get_scope_context`(read 7곳은 API키 toolgroup
scope 체크만 생략한 `get_scope_context_no_key_scope_check`) 경유로 통일 — X-Project-Id 헤더를
우선 적용하되 has_project_access 멤버십 검증은 항상 선다(read/write 공통).
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


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _seed_two_projects(session):
    """org에 project A(caller 접근권 O, 아티팩트 3건 시딩·유나 재현의 60+건 대리값)·
    project B(caller 접근권 X — 음성대조), 그리고 caller가 속하지 않은 org C·project D
    (cross-org 헤더 거부 음성대조)."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User
    from app.models.visual_artifact import VisualArtifact

    org = Organization(id=uuid.uuid4(), name="Org2708", slug=f"org2708-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="A(갤러리)")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="B(접근권없음)")
    session.add(project_a)
    session.add(project_b)
    await session.commit()

    for i in range(3):
        session.add(VisualArtifact(
            id=uuid.uuid4(), org_id=org.id, project_id=project_a.id,
            title=f"artifact-{i}", created_by=uuid.uuid4(),
        ))
    await session.commit()

    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(caller_om)
    await session.commit()
    # caller는 project A만 접근권 — project B는 미부여(음성대조).
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, org_member_id=caller_om.id,
        permission="granted", role="member",
    ))
    await session.commit()

    # 타 org(cross-org 헤더 거부 음성대조) — caller는 이 org 소속이 아님.
    org_c = Organization(id=uuid.uuid4(), name="OrgC", slug=f"orgc-{uuid.uuid4().hex[:8]}")
    session.add(org_c)
    await session.commit()
    project_d = Project(id=uuid.uuid4(), org_id=org_c.id, name="D(타org)")
    session.add(project_d)
    await session.commit()

    return {
        "org_id": org.id, "project_a_id": project_a.id, "project_b_id": project_b.id,
        "caller_id": caller_id, "project_d_id": project_d.id,
    }


async def _setup_app_jwt_with_stale_project(app, Session, org_id, caller_id, stale_project_id):
    """JWT에 프로젝트 A/B와 무관한 stale project_id가 구워진 상태를 재현(원 인시던트 —
    브라우저 세션 발급 시점의 기본/구 프로젝트) — X-Project-Id 헤더로 override되는지가
    이 스토리의 핵심 검증축."""
    from app.dependencies.auth import AuthContext, get_current_user
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
            user_id=str(caller_id), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id), "project_id": str(stale_project_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_gallery_bare_list_positive_x_project_id_header_wins_over_stale_jwt():
    """양성대조(유나 재현 그대로) — JWT엔 stale(무관) project_id가 구워져 있지만, 갤러리가
    보내는 X-Project-Id 헤더(project A)가 이겨 실 아티팩트(3건, 60+건의 대리값)가 보인다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_projects(s)
        stale = uuid.uuid4()  # JWT에 구워진, 실제로 존재하지도 않는 "다른" project
        await _setup_app_jwt_with_stale_project(app, Session, seeded["org_id"], seeded["caller_id"], stale)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/visual-artifacts",
                headers={"X-Project-Id": str(seeded["project_a_id"])},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert len(body["data"]) == 3, "갤러리가 실 아티팩트를 못 봄 — 원 버그 재현"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_read_route_negative_no_access_to_header_project_403():
    """음성대조 ② — caller가 접근권 없는 project_id(B)를 헤더로 지정하면 read 라우트도
    403(project 멤버십 검증은 toolgroup scope 면제와 무관하게 항상 선다, PO 조건②)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_projects(s)
        await _setup_app_jwt_with_stale_project(
            app, Session, seeded["org_id"], seeded["caller_id"], seeded["project_a_id"]
        )
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/visual-artifacts",
                headers={"X-Project-Id": str(seeded["project_b_id"])},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_read_route_negative_cross_org_project_header_rejected():
    """음성대조 — 타 org(org_c)의 project_id(D)를 헤더로 지정하면 거부된다(cross-org 헤더
    악용 방지, PO 조건④)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_projects(s)
        await _setup_app_jwt_with_stale_project(
            app, Session, seeded["org_id"], seeded["caller_id"], seeded["project_a_id"]
        )
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/visual-artifacts",
                headers={"X-Project-Id": str(seeded["project_d_id"])},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_read_route_toolgroup_scope_still_exempt_for_api_key():
    """read 라우트는 project 멤버십 검증은 서지만, API키 toolgroup scope 체크(story b4027b2e)는
    여전히 면제된다(PO 조건① — scope 미보유 API키라도 read는 통과) — 회귀 확認."""
    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.database import get_db
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_projects(s)

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
                user_id=str(seeded["caller_id"]), email=None,
                claims={"app_metadata": {
                    "org_id": str(seeded["org_id"]), "project_id": str(seeded["project_a_id"]),
                    "api_key_id": str(uuid.uuid4()), "scope": ["docs"],
                }},
            )

        app.dependency_overrides[get_db] = _db
        app.dependency_overrides[get_current_user] = _auth
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/visual-artifacts")
            assert resp.status_code == 200, resp.text
            assert len(resp.json()["data"]) == 3
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
