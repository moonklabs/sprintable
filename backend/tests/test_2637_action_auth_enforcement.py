"""story #2637 §범위3 후속(미르코 발견, 2026-08-14) — publish_registry_event가
EventDefinition.action_auth를 발행 시점에 실제로 집행하는지.

이전엔 block_template.actions[].auth가 등록 시점 구조 검증만 받고 발행 시점엔 아무도
안 봤다 — FE만 버튼을 숨기면 "금지 AC=서버가 거부"가 성립하지 않는다(#2091 클래스). 이
엔드포인트가 버튼/REST/MCP 전부의 유일한 발행 경로라 경로 구분 없이 여기 하나로 검증한다.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _realdb_session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_project(session, *, slug="acme"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2637aa", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id, *, name="agent", role="member"):
    from app.models.team import TeamMember

    m = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name,
        is_active=True, role=role,
    )
    session.add(m)
    await session.commit()
    return m.id


async def _seed_org_member_human(session, org_id, project_id, *, role="admin"):
    """OrgMember(레거시 resolve_member 조회 축, id=team_members row와 동일 id 사용) +
    TeamMember(type=human) 2종 세트.

    team_members VIEW(migration 0088, members ⋈ project_access)는 real-migrated DB에만
    존재한다 — 이 테스트는 Base.metadata.create_all()만 쓰므로 team_members는 그냥
    TeamMember 모델이 그대로 만드는 리터럴 테이블이다. resolve_member()의 LEGACY 휴먼
    분기는 sender.id=OrgMember.id를 conversations.created_by에 그대로 쓰므로, 그 id로
    조회 가능한 TeamMember(type="human") 행이 있어야 FK가 통과한다(#2637 그라운딩 중
    ForeignKeyViolationError로 실측 발견 — Member/ProjectAccess 3종 조합은 VIEW 전용이라
    create_all 경로엔 무관했다)."""
    from app.models.project import OrgMember
    from app.models.team import TeamMember

    user_id = uuid.uuid4()
    member_id = uuid.uuid4()
    session.add(OrgMember(id=member_id, org_id=org_id, user_id=user_id, role=role))
    session.add(TeamMember(
        id=member_id, org_id=org_id, project_id=project_id, type="human", name="Human",
        role=role, is_active=True,
    ))
    await session.commit()
    return user_id


async def _seed_definition(session, org_id, *, key, action_auth):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=key, org_id=org_id,
        payload_schema={
            "type": "object", "additionalProperties": False,
            "properties": {"goal_id": {"type": "string"}},
        },
        routing={
            "escalation": {"kind": "server_derived", "target": "none"},
            "broadcast": {"kind": "server_derived", "target": "none"},
        },
        action_auth=action_auth,
    )
    session.add(d)
    await session.commit()
    return d


async def _seed_goal(session, org_id, project_id):
    from app.models.pm import Goal

    goal = Goal(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="G")
    session.add(goal)
    await session.commit()
    return goal.id


def _agent_auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


def _human_auth(user_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(user_id), email="human@example.com",
        claims={"app_metadata": {"org_id": str(org_id)}}, org_id=str(org_id),
    )


def _fake_request() -> "StarletteRequest":
    """story #2674 — publish_registry_event가 이제 request(X-Project-Id 헤더 폴백)를 받는다.
    이 파일의 테스트들은 전부 work_item 참조가 있어 project 해소가 그 경로에서 끝나므로
    헤더 없는 최소 요청으로 충분(신규 파라미터 자리만 채운다)."""
    from starlette.requests import Request as StarletteRequest

    return StarletteRequest(scope={"type": "http", "headers": []})


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_human_only_blocks_agent_publisher():
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            await _seed_definition(s, org_id, key="org.acme.thing.done", action_auth={"human_only": True})

            with pytest.raises(HTTPException) as ei:
                await publish_registry_event(
                    EventPublishRequest(definition_key="org.acme.thing.done", payload={}),
                    BackgroundTasks(), _fake_request(), db=s, auth=_agent_auth(agent_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 403
            assert ei.value.detail["code"] == "action_auth_denied"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_human_only_allows_human_publisher():
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            human_id = await _seed_org_member_human(s, org_id, project_id)
            goal_id = await _seed_goal(s, org_id, project_id)
            await _seed_definition(s, org_id, key="org.acme.thing.done", action_auth={"human_only": True})

            resp = await publish_registry_event(
                EventPublishRequest(definition_key="org.acme.thing.done", payload={"goal_id": str(goal_id)}),
                BackgroundTasks(), _fake_request(), db=s, auth=_human_auth(human_id, org_id), org_id=org_id,
            )
            assert "message_id" in resp
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_role_mismatch_blocks_publisher():
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org_id, project_id, role="member")
            await _seed_definition(
                s, org_id, key="org.acme.thing.done", action_auth={"role": ["admin", "owner"]},
            )

            with pytest.raises(HTTPException) as ei:
                await publish_registry_event(
                    EventPublishRequest(definition_key="org.acme.thing.done", payload={}),
                    BackgroundTasks(), _fake_request(), db=s, auth=_agent_auth(agent_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 403
            assert ei.value.detail["code"] == "action_auth_denied"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_role_match_allows_publisher():
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org_id, project_id, role="admin")
            goal_id = await _seed_goal(s, org_id, project_id)
            await _seed_definition(
                s, org_id, key="org.acme.thing.done", action_auth={"role": ["admin", "owner"]},
            )

            resp = await publish_registry_event(
                EventPublishRequest(definition_key="org.acme.thing.done", payload={"goal_id": str(goal_id)}),
                BackgroundTasks(), _fake_request(), db=s, auth=_agent_auth(agent_id, org_id), org_id=org_id,
            )
            assert "message_id" in resp
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_no_action_auth_is_unrestricted_non_regression():
    """action_auth 없는 정의는 현행 그대로(비회귀) — agent도 자유롭게 발행."""
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org_id, project_id, role="member")
            goal_id = await _seed_goal(s, org_id, project_id)
            await _seed_definition(s, org_id, key="org.acme.thing.done", action_auth=None)

            resp = await publish_registry_event(
                EventPublishRequest(definition_key="org.acme.thing.done", payload={"goal_id": str(goal_id)}),
                BackgroundTasks(), _fake_request(), db=s, auth=_agent_auth(agent_id, org_id), org_id=org_id,
            )
            assert "message_id" in resp
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_combined_human_only_and_role_both_enforced():
    """human_only+role 동시 지정 — human이어도 role 불일치면 여전히 거부(AND 결합)."""
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            human_id = await _seed_org_member_human(s, org_id, project_id, role="member")
            await _seed_definition(
                s, org_id, key="org.acme.thing.done",
                action_auth={"human_only": True, "role": ["owner"]},
            )

            with pytest.raises(HTTPException) as ei:
                await publish_registry_event(
                    EventPublishRequest(definition_key="org.acme.thing.done", payload={}),
                    BackgroundTasks(), _fake_request(), db=s, auth=_human_auth(human_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 403
    finally:
        await engine.dispose()
