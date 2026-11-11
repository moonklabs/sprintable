"""story #4888(UI-5 홈, 실물 측정 11-11) — 실제 `GET /api/v2/today`: 에이전트 «결정 요청» 행 = 제목(질문) · 사유(가정) · 요청자(이름), facts가 빈 요청은 지어내지 않고 빈 채로.

DB 없는 쪽(순수 도우미 · 매핑)은 `test_4888_today_decision_request_title.py`. 이 파일은 실 PG가 필요해 create_all을 부르므로 destructive_schema 표식 · 샤드 무게 등록이 따른다.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
    pytest.mark.destructive_schema,
]

@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL or ""
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _make_member(session, org_id, project_id, *, org_role="member", name="member", member_type="human"):
    from app.models.user import User
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.member import Member

    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=org_role)
    session.add(om)
    await session.flush()
    m = Member(id=om.id, org_id=org_id, type=member_type, user_id=user.id, name=name)
    session.add(m)
    await session.flush()
    session.add(ProjectAccess(project_id=project_id, org_member_id=om.id, member_id=m.id, role="member"))
    await session.commit()
    return m.id, user.id


async def _setup_app_human(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
    from tests.conftest import override_db_and_read

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(user_id=str(user_id), email="human@test", claims={"app_metadata": {"org_id": str(org_id)}})

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


async def test_today_shows_the_decision_question_as_title_with_assumption_and_requester_realdb(_dispose_global_engine_after_test):
    """실제 `GET /api/v2/today`: 결정 요청 행 = 제목(질문) · 사유(가정) · 요청자(이름) — 그리고 facts가 빈 요청은 지어내지 않고 빈 채로."""
    from httpx import AsyncClient, ASGITransport
    from app.main import app
    from app.models.gate import Gate
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.team import TeamMember
    from app.services.gate_service import DECISION_REQUEST_GATE_TYPE

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="Org4888", slug=f"org4888-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
            s.add(project)
            await s.commit()
            owner_id, owner_user_id = await _make_member(s, org.id, project.id, org_role="owner", name="owner")
            # 요청자 이름은 team_members에서 읽는다(에이전트는 team_members 행 — gates.py::create_decision_request의 caller_id가 가리키는 것)
            agent = TeamMember(id=uuid.uuid4(), org_id=org.id, project_id=project.id, type="agent", name="개발 에이전트")
            s.add(agent)
            await s.commit()
            agent_id = agent.id
            with_facts = Gate(
                id=uuid.uuid4(), org_id=org.id, work_item_id=uuid.uuid4(), work_item_type="agent_decision", gate_type=DECISION_REQUEST_GATE_TYPE, status="pending",
                neutral_facts={"question": "랜딩 첫 화면 문구를 «가격 먼저»로 바꿔도 될까요?", "assumption": "가격 문의가 많아요", "requested_by_member_id": str(agent_id), "project_id": str(project.id)},
            )
            bare = Gate(
                id=uuid.uuid4(), org_id=org.id, work_item_id=uuid.uuid4(), work_item_type="agent_decision", gate_type=DECISION_REQUEST_GATE_TYPE, status="pending",
                neutral_facts={},
            )
            s.add_all([with_facts, bare])
            await s.commit()
            with_facts_id, bare_id = with_facts.id, bare.id

        await _setup_app_human(app, Session, owner_user_id, org.id)
        client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        try:
            resp = await client.get("/api/v2/today")
            assert resp.status_code == 200, resp.text
            items = {i["source_id"]: i for i in resp.json()["needs_me"]}
            full = items[str(with_facts_id)]
            assert full["work_item"]["title"] == "랜딩 첫 화면 문구를 «가격 먼저»로 바꿔도 될까요?"
            assert full["reason"] == "가격 문의가 많아요"
            assert full["requested_by"] == {"id": str(agent_id), "name": "개발 에이전트"}
            empty = items[str(bare_id)]
            assert empty["work_item"]["title"] == "" and empty["reason"] is None and empty["requested_by"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
