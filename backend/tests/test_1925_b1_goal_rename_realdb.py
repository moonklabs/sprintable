"""계층 리네이밍 B1(story 1925): epics→goals 전면 rename + 구 이름 별칭 무중단 서빙 — 실 PG.

hierarchy-rename-alias-mechanism-design의 3층(REST 경로·MCP tool·JSON 필드)이 실제로 신/구
양쪽 동시 서빙되는지 실증. 마이그(0195) 자체는 다른 realdb 테스트들이 매 실행마다 간접
검증(alembic upgrade head가 실패하면 전부 실패)하므로 여기선 스키마/라우팅 계약만 집중."""
from __future__ import annotations

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


async def _seed_org_project_member(session):
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    user_id = uuid.uuid4()
    human = Member(id=user_id, org_id=org.id, type="human", name="U")
    session.add(human)
    await session.commit()
    session.add(ProjectAccess(id=uuid.uuid4(), project_id=project.id, member_id=user_id, permission="granted"))
    await session.commit()
    return org.id, project.id, user_id


@pytest.mark.anyio
async def test_goal_table_exists_and_epics_table_gone():
    """마이그 0195 실효 확인 — goals 테이블 존재, epics는 더 이상 없음(rename, 복사 아님)."""
    from sqlalchemy import text

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            goals_exists = (await s.execute(
                text("SELECT to_regclass('public.goals') IS NOT NULL")
            )).scalar_one()
            epics_exists = (await s.execute(
                text("SELECT to_regclass('public.epics') IS NOT NULL")
            )).scalar_one()
        assert goals_exists is True
        assert epics_exists is False
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_rest_new_and_old_path_both_serve_same_data():
    """POST /api/v2/goals로 생성 → GET /api/v2/goals/{id}와 GET /api/v2/epics/{id}(별칭) 둘 다
    동일 레코드를 반환해야 한다(같은 router 객체 double-include, 로직 복제 0)."""
    from httpx import ASGITransport, AsyncClient
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.dependencies.database import get_db
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, user_id = await _seed_org_project_member(s)

        async def _override_db():
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
                create_resp = await c.post("/api/v2/goals", json={
                    "project_id": str(project_id), "org_id": str(org_id), "title": "Goal via new path",
                })
                assert create_resp.status_code == 201
                goal_id = create_resp.json()["id"]

                via_new = await c.get(f"/api/v2/goals/{goal_id}")
                via_old = await c.get(f"/api/v2/epics/{goal_id}")
                assert via_new.status_code == 200
                assert via_old.status_code == 200
                assert via_new.json()["title"] == via_old.json()["title"] == "Goal via new path"
                assert via_new.json()["id"] == via_old.json()["id"] == goal_id
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_old_rest_path_create_still_works():
    """구 경로(POST /api/v2/epics)로도 여전히 생성 가능해야 한다(무중단 별칭)."""
    from httpx import ASGITransport, AsyncClient
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.dependencies.database import get_db
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, user_id = await _seed_org_project_member(s)

        async def _override_db():
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
                resp = await c.post("/api/v2/epics", json={
                    "project_id": str(project_id), "org_id": str(org_id), "title": "Goal via old path",
                })
                assert resp.status_code == 201
                assert resp.json()["title"] == "Goal via old path"
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


def test_mcp_tool_alias_same_handler_both_names():
    """신(sprintable_add_goal)과 구(sprintable_add_epic) MCP tool 이름이 정확히 같은 핸들러
    함수를 가리켜야 한다(로직 복제 0 — 별칭이 실제로 별칭임을 실증)."""
    import sprintable_mcp.server as server

    by_name = {t[0]: t[3] for t in server._TOOL_DEFS}
    assert by_name["sprintable_add_goal"] is by_name["sprintable_add_epic"]
    assert by_name["sprintable_list_goals"] is by_name["sprintable_list_epics"]
    assert by_name["sprintable_update_goal"] is by_name["sprintable_update_epic"]
    assert by_name["sprintable_get_goal_progress"] is by_name["sprintable_get_epic_progress"]


def test_mcp_update_goal_input_accepts_both_field_names():
    """UpdateGoalInput이 신(goal_id)/구(epic_id) 필드명 둘 다 수용해야 한다(deprecated 별칭
    tool도 같은 스키마를 쓰므로 구 필드명이 죽으면 안 됨)."""
    from sprintable_mcp.tools.goals import UpdateGoalInput

    via_new = UpdateGoalInput.model_validate({"goal_id": "abc", "title": "t"})
    via_old = UpdateGoalInput.model_validate({"epic_id": "abc", "title": "t"})
    assert via_new.goal_id == "abc"
    assert via_old.goal_id == "abc"
