"""story #4350 — project 필터 없는 목록이 같은 org 안 **접근 권한 없는 프로젝트**의 항목을 내지 않는다.

까디르 codex(4346 QA): `GET /api/v2/stories` · `GET /api/v2/goals`를 project_id 없이 부르면 BE가 org로만 걸렀다(스프린트는 SEC-S8
83ea3d6a에서 «org 전체 노출 = 갭»으로 확정돼 접근 가능 프로젝트로 거름). 사람 세션 · 에이전트 키 둘 다.
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_1994_backlink_api_realdb import _make_agent_member
from tests.test_e_security_sec_s8_g_cross_project_access_realdb import _REAL_DB_URL, _session_factory

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


async def _seed(s):
    """org · project A/B · 각 프로젝트에 story 1 · goal 1 · project A에만 접근 권한이 있는 사람."""
    from app.models.organization import Organization
    from app.models.pm import Goal, Story
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    s.add(org)
    await s.commit()
    pa = Project(id=uuid.uuid4(), org_id=org.id, name="A")
    pb = Project(id=uuid.uuid4(), org_id=org.id, name="B")
    s.add_all([pa, pb])
    await s.commit()
    story_a = Story(id=uuid.uuid4(), org_id=org.id, project_id=pa.id, title="Story A")
    story_b = Story(id=uuid.uuid4(), org_id=org.id, project_id=pb.id, title="Story B")
    goal_a = Goal(id=uuid.uuid4(), org_id=org.id, project_id=pa.id, title="Goal A")
    goal_b = Goal(id=uuid.uuid4(), org_id=org.id, project_id=pb.id, title="Goal B")
    s.add_all([story_a, story_b, goal_a, goal_b])
    await s.commit()
    uid = uuid.uuid4()
    s.add(User(id=uid, email=f"h-{uid.hex[:8]}@test.com", hashed_password="x"))
    await s.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=uid, role="member")
    s.add(om)
    await s.commit()
    s.add(ProjectAccess(id=uuid.uuid4(), project_id=pa.id, org_member_id=om.id, permission="granted", role="member"))
    await s.commit()
    agent_id = await _make_agent_member(s, org.id, pa.id)  # 에이전트도 project A에만
    # grant가 하나도 없는 사람(org member · owner/admin 아님) — «전체»가 아니라 0건이어야 한다(까디르 매트릭스).
    nobody = uuid.uuid4()
    s.add(User(id=nobody, email=f"n-{nobody.hex[:8]}@test.com", hashed_password="x"))
    await s.commit()
    s.add(OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=nobody, role="member"))
    await s.commit()
    return {
        "org": org.id, "pa": pa.id, "pb": pb.id, "user": uid, "agent": agent_id, "nobody": nobody,
        "story_a": str(story_a.id), "story_b": str(story_b.id), "goal_a": str(goal_a.id), "goal_b": str(goal_b.id),
    }


async def _get(Session, seeded, path, caller, *, expect_status=200, want_headers=False):
    from httpx import ASGITransport, AsyncClient

    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.database import get_db, get_read_db
    from app.main import app

    async def _db():
        async with Session() as s:
            yield s

    async def _auth():
        if caller == "agent":
            # 에이전트 키 모양 — user_id = 멤버 id · app_metadata.api_key_id.
            return AuthContext(
                user_id=str(seeded["agent"]), email=None,
                claims={"app_metadata": {"api_key_id": "k-4350", "org_id": str(seeded["org"])}}, org_id=str(seeded["org"]),
            )
        # 사람 세션 모양 — JWT app_metadata에 org · 자기 프로젝트(A). «nobody»는 grant 0.
        return AuthContext(
            user_id=str(seeded["nobody" if caller == "nobody" else "user"]), email="h@test",
            claims={"app_metadata": {"org_id": str(seeded["org"]), "project_id": str(seeded["pa"])}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_read_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get(path)
        assert resp.status_code == expect_status, resp.text
        if expect_status != 200:
            return resp
        body = resp.json()
        data = body["data"] if isinstance(body, dict) and "data" in body else body
        ids = {item["id"] for item in data}
        return (ids, resp.headers) if want_headers else ids
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize("caller", ["human", "agent"])
@pytest.mark.parametrize("path,own,other", [
    ("/api/v2/stories", "story_a", "story_b"),
    ("/api/v2/goals", "goal_a", "goal_b"),
])
async def test_list_without_project_filter_hides_inaccessible_projects(path, own, other, caller):
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        ids = await _get(Session, seeded, path, caller)
        assert seeded[own] in ids, "접근 가능한 프로젝트 항목은 그대로 나온다(회귀 0)"
        assert seeded[other] not in ids, "접근 권한 없는 프로젝트(B)의 항목이 섞이면 안 된다"
    finally:
        await engine.dispose()


@pytest.mark.parametrize("path", ["/api/v2/stories", "/api/v2/goals"])
async def test_member_with_no_grant_sees_nothing_and_total_counts_only_accessible(path):
    """까디르 매트릭스 — grant 0 구성원은 0건(«전체» 아님) · X-Total-Count도 접근 가능 행만."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        ids, headers = await _get(Session, seeded, path, "nobody", want_headers=True)
        assert ids == set()
        assert headers.get("x-total-count") in (None, "0")
        ids, headers = await _get(Session, seeded, path, "human", want_headers=True)
        assert headers.get("x-total-count") in (None, str(len(ids))), "총계가 접근 불가 프로젝트 행을 세면 존재가 샌다"
        assert len(ids) == 1
    finally:
        await engine.dispose()


@pytest.mark.parametrize("path", ["/api/v2/stories", "/api/v2/goals"])
async def test_explicit_inaccessible_project_returns_no_rows(path):
    """접근 불가 project_id를 명시하면 행 0(거절 응답 · 본문에 그 프로젝트 항목 없음)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        from httpx import ASGITransport, AsyncClient

        from app.dependencies.auth import AuthContext, get_current_user
        from app.dependencies.database import get_db, get_read_db
        from app.main import app

        async def _db():
            async with Session() as s:
                yield s

        async def _auth():
            return AuthContext(
                user_id=str(seeded["user"]), email="h@test",
                claims={"app_metadata": {"org_id": str(seeded["org"]), "project_id": str(seeded["pa"])}},
            )

        app.dependency_overrides[get_db] = _db
        app.dependency_overrides[get_read_db] = _db
        app.dependency_overrides[get_current_user] = _auth
        try:
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
                resp = await c.get(f"{path}?project_id={seeded['pb']}")
        finally:
            app.dependency_overrides.clear()
        if resp.status_code == 200:
            body = resp.json()
            data = body["data"] if isinstance(body, dict) and "data" in body else body
            assert data == [], resp.text
        else:
            assert resp.status_code in (403, 404), resp.text
            assert seeded["story_b"] not in resp.text and seeded["goal_b"] not in resp.text
    finally:
        await engine.dispose()
