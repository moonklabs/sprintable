"""story #4350 — project 필터 없는 목록이 같은 org 안 **접근 권한 없는 프로젝트**의 항목을 내지 않는다.

까디르 codex(4346 QA): `GET /api/v2/stories` · `GET /api/v2/goals`를 project_id 없이 부르면 BE가 org로만 걸렀다(스프린트는 SEC-S8
83ea3d6a에서 «org 전체 노출 = 갭»으로 확정돼 접근 가능 프로젝트로 거름). 사람 세션 · 에이전트 키 둘 다.
"""
from __future__ import annotations

import uuid

import pytest

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
    return {
        "org": org.id, "pa": pa.id, "pb": pb.id, "user": uid,
        "story_a": str(story_a.id), "story_b": str(story_b.id), "goal_a": str(goal_a.id), "goal_b": str(goal_b.id),
    }


async def _get(Session, seeded, path):
    from httpx import ASGITransport, AsyncClient

    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.database import get_db, get_read_db
    from app.main import app

    async def _db():
        async with Session() as s:
            yield s

    async def _auth():
        # 사람 세션 모양 — JWT app_metadata에 org · 자기 프로젝트(A).
        return AuthContext(
            user_id=str(seeded["user"]), email="h@test",
            claims={"app_metadata": {"org_id": str(seeded["org"]), "project_id": str(seeded["pa"])}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_read_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get(path)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        data = body["data"] if isinstance(body, dict) and "data" in body else body
        return {item["id"] for item in data}
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize("path,own,other", [
    ("/api/v2/stories", "story_a", "story_b"),
    ("/api/v2/goals", "goal_a", "goal_b"),
])
async def test_list_without_project_filter_hides_inaccessible_projects(path, own, other):
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        ids = await _get(Session, seeded, path)
        assert seeded[own] in ids, "접근 가능한 프로젝트 항목은 그대로 나온다(회귀 0)"
        assert seeded[other] not in ids, "접근 권한 없는 프로젝트(B)의 항목이 섞이면 안 된다"
    finally:
        await engine.dispose()
