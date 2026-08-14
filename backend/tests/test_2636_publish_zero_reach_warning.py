"""story #2636(P1b) 갭 1호 처방 — 발행 응답 zero_reach_warning.

전환 실측(가동 1시간, 페드루군 실제 사고): work_item 미배정 → work_item_stakeholders 해석이
빈 집합 → 발행은 201로 "성공"하지만 escalation·broadcast 둘 다 아무도 못 받는다. 응답에
명시 경고 필드(zero_reach_warning + warning 문장)를 실어 이 조용한 무도달을 봉쇄한다.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import BackgroundTasks

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


def _load_seed_definitions():
    import importlib.util
    import os

    spec = importlib.util.spec_from_file_location(
        "_m0245zr", os.path.join(os.path.dirname(__file__), "..", "alembic", "versions", "0245_event_definitions.py"),
    )
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return {key: (payload_schema, routing) for key, payload_schema, routing in m._SEED}


async def _seed_preset_definitions(session):
    from app.models.event_definition import EventDefinition

    for key, (payload_schema, routing) in _load_seed_definitions().items():
        session.add(EventDefinition(
            id=uuid.uuid4(), key=key, org_id=None, payload_schema=payload_schema, routing=routing,
        ))
    await session.commit()


async def _seed_org_project(session, *, slug="acme"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2636zr", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True,
    )
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, assignee_id=None, human_owner_member_id=None):
    from app.models.pm import Story

    story = Story(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="S",
        assignee_id=assignee_id, human_owner_member_id=human_owner_member_id,
    )
    session.add(story)
    await session.commit()
    return story.id


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_unassigned_work_item_returns_zero_reach_warning():
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_definitions(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            # 미배정 story — assignee/human_owner 둘 다 없음 → stakeholders 해석 빈 집합.
            story_id = await _seed_story(s, org_id, project_id)

            body = EventPublishRequest(
                definition_key="preset.gate.verdict",
                payload={
                    "work_item_type": "story", "work_item_id": str(story_id),
                    "gate_type": "merge", "verdict": "approved",
                },
            )
            resp = await publish_registry_event(
                body, BackgroundTasks(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )
            assert resp["zero_reach_warning"] is True
            assert "warning" in resp
            assert resp["escalation_member_ids"] == []
            assert resp["broadcast_member_ids"] == []
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_assigned_work_item_no_warning():
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_definitions(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            owner_id = await _seed_agent(s, org_id, project_id, name="owner")
            story_id = await _seed_story(s, org_id, project_id, human_owner_member_id=owner_id)

            body = EventPublishRequest(
                definition_key="preset.gate.verdict",
                payload={
                    "work_item_type": "story", "work_item_id": str(story_id),
                    "gate_type": "merge", "verdict": "approved",
                },
            )
            resp = await publish_registry_event(
                body, BackgroundTasks(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )
            assert resp["zero_reach_warning"] is False
            assert "warning" not in resp
    finally:
        await engine.dispose()
