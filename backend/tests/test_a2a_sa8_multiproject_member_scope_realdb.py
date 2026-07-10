"""E-A2A-완성 S-A8(story 7d4ad784, hotfix): `_get_agent_member`의 `MultipleResultsFound` 봉인.

`team_members`는 뷰(members⋈project_access, 마이그 0110 A안 — grant SSOT, 의도된 설계)라
멀티프로젝트 grant 에이전트는 project_access 개수만큼 행으로 fan-out한다. prod 산티아고
(c7a8dd0e, 2 project 소속)의 `GET .../agent-card.json` 500(sqlalchemy.exc.MultipleResultsFound)
을 실 재현하려면 `create_all()`(단일 테이블)이 아니라 **실 Alembic 마이그**(진짜 VIEW)가 필요
— 그래서 story 8236bbc3의 destructive_schema 컨벤션이 아니라 `reference_local_migration_verify`
패턴(alembic upgrade heads)을 쓴다."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요 — alembic upgrade heads 적용된 DB"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    """`get_agent_card`/`a2a_rpc`는 `app.core.database`의 **모듈-전역** engine을 쓴다(자체
    세션 팩토리) — anyio 테스트마다 새 이벤트루프가 뜨는데 전역 커넥션 풀은 첫 테스트의 루프에
    바인딩된 채 남아 다음 테스트(다른 루프)에서 asyncpg가 cross-loop RuntimeError를 낸다.
    각 테스트 뒤 풀을 폐기(established pattern, test_a2a_sa1_deadline_sweeper_realdb.py)."""
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


async def _seed_multiproject_agent(session):
    """산티아고 실사례 재현: agent 1명(members)이 project_access grant 2개(project_id 다름)."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    org = Organization(id=uuid.uuid4(), name="S-A8 Org", slug=f"sa8-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="Project A")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="Project B")
    agent = Member(
        id=uuid.uuid4(), org_id=org.id, type="agent", name="Multi-Project Agent", is_active=True,
    )
    session.add_all([project_a, project_b, agent])
    await session.commit()

    grant_a = ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, member_id=agent.id, permission="granted", role="member",
    )
    grant_b = ProjectAccess(
        id=uuid.uuid4(), project_id=project_b.id, member_id=agent.id, permission="granted", role="member",
    )
    session.add_all([grant_a, grant_b])
    await session.commit()
    return org.id, project_a.id, project_b.id, agent.id


async def _seed_single_project_agent(session, org_id):
    from app.models.member import Member
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    project = Project(id=uuid.uuid4(), org_id=org_id, name="Solo Project")
    agent = Member(id=uuid.uuid4(), org_id=org_id, type="agent", name="Solo Agent", is_active=True)
    session.add_all([project, agent])
    await session.commit()
    grant = ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted", role="member",
    )
    session.add(grant)
    await session.commit()
    return project.id, agent.id


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _authed_agent_card_overrides(app, org_id):
    """E-SECURITY SEC-S2: agent-card.json이 authed+same-org로 승격 — 발견 테스트도 호출자 org 인증 필요."""
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id

    async def _auth():
        return AuthContext(
            user_id=str(uuid.uuid4()), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    async def _org():
        return org_id

    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


@pytest.mark.anyio
async def test_agent_card_multiproject_member_no_longer_500s():
    """S-A8 AC3: 멀티-project agent의 agent-card가 200 정상 카드(회귀: 이전엔 MultipleResultsFound 500)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_a, project_b, agent_id = await _seed_multiproject_agent(s)

        async def _db():
            async with Session() as s:
                yield s

        from app.dependencies.database import get_db
        app.dependency_overrides[get_db] = _db
        await _authed_agent_card_overrides(app, org_id)

        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/a2a/members/{agent_id}/agent-card.json")
            assert resp.status_code == 200, resp.text
            card = resp.json()
            assert card["name"] == "Multi-Project Agent"
            assert "skills" in card and len(card["skills"]) >= 1
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_card_single_project_member_regression_zero():
    """S-A8 AC3 회귀 0: 단일-project agent는 기존과 동일하게 200."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_a, project_b, _ = await _seed_multiproject_agent(s)
            solo_project_id, solo_agent_id = await _seed_single_project_agent(s, org_id)

        async def _db():
            async with Session() as s:
                yield s

        from app.dependencies.database import get_db
        app.dependency_overrides[get_db] = _db
        await _authed_agent_card_overrides(app, org_id)

        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/a2a/members/{solo_agent_id}/agent-card.json")
            assert resp.status_code == 200, resp.text
            assert resp.json()["name"] == "Solo Agent"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_rpc_multiproject_member_honors_project_hint():
    """S-A8: authed /rpc가 X-Project-Id(app_metadata.project_id) 힌트로 project A를 결정적으로 고른다.

    검증: 힌트=project_a로 SendMessage → 생성된 Conversation.project_id가 정확히 project_a."""
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.dependencies.database import get_db
    from app.main import app
    from app.models.conversation import Conversation
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_a, project_b, agent_id = await _seed_multiproject_agent(s)
            caller_id = uuid.uuid4()

        async def _db():
            async with Session() as s:
                yield s

        async def _auth():
            return AuthContext(
                user_id=str(caller_id), email="caller@test",
                claims={"app_metadata": {"project_id": str(project_a)}},
            )

        async def _org():
            return org_id

        app.dependency_overrides[get_db] = _db
        app.dependency_overrides[get_current_user] = _auth
        app.dependency_overrides[get_verified_org_id] = _org

        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/a2a/members/{agent_id}/rpc",
                json={
                    "jsonrpc": "2.0", "id": "1", "method": "SendMessage",
                    "params": {"message": {
                        "messageId": str(uuid.uuid4()), "role": "ROLE_USER",
                        "parts": [{"text": "hint test"}],
                    }},
                },
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert "error" not in body or body.get("error") is None, body
            task_id = uuid.UUID(body["result"]["task"]["id"])

            async with Session() as s:
                from app.models.a2a_task import A2ATask
                task = (await s.execute(select(A2ATask).where(A2ATask.id == task_id))).scalar_one()
                conv = (await s.execute(
                    select(Conversation).where(Conversation.id == task.context_id)
                )).scalar_one()
                assert conv.project_id == project_a, (
                    f"project 힌트(project_a={project_a}) 무시됨 — 실제 project_id={conv.project_id}"
                )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_rpc_multiproject_member_deterministic_fallback_without_hint():
    """S-A8: authed /rpc에 project 힌트 없으면 크래시 없이 결정적 폴백(project_id 오름차순 최소값)."""
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.dependencies.database import get_db
    from app.main import app
    from app.models.conversation import Conversation
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_a, project_b, agent_id = await _seed_multiproject_agent(s)
            caller_id = uuid.uuid4()
        expected_project_id = min(project_a, project_b)

        async def _db():
            async with Session() as s:
                yield s

        async def _auth():
            return AuthContext(user_id=str(caller_id), email="caller@test", claims={})

        async def _org():
            return org_id

        app.dependency_overrides[get_db] = _db
        app.dependency_overrides[get_current_user] = _auth
        app.dependency_overrides[get_verified_org_id] = _org

        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/a2a/members/{agent_id}/rpc",
                json={
                    "jsonrpc": "2.0", "id": "1", "method": "SendMessage",
                    "params": {"message": {
                        "messageId": str(uuid.uuid4()), "role": "ROLE_USER",
                        "parts": [{"text": "no hint test"}],
                    }},
                },
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert "error" not in body or body.get("error") is None, body
            task_id = uuid.UUID(body["result"]["task"]["id"])

            async with Session() as s:
                from app.models.a2a_task import A2ATask
                task = (await s.execute(select(A2ATask).where(A2ATask.id == task_id))).scalar_one()
                conv = (await s.execute(
                    select(Conversation).where(Conversation.id == task.context_id)
                )).scalar_one()
                assert conv.project_id == expected_project_id
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
