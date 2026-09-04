"""story 8b7e52d6(제품·신호, 페드루 PO 재정의 2026-09-04) — claim_story 응답 스코프 신호.

story 3414b6d7 결정(claim은 participation만 건드리고 assignee/board는 절대 안 건드림)
은 그대로 — 이 스토리는 «행동 변경»이 아니라 «신호 보정». AC 커버: 응답에 participation/
assignee_changed(항상 False)/assignee_ids(현재값) 노출·assignee 비어있을 때만 hint·
assignee 있으면 hint 부재·3414b6d7 회귀(assignee 실제 미변경) pin."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
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


async def _seed_org(session, *, slug=None):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="8b7e52d6 Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    # 실 org 생성 경로(OrganizationRepository.create)는 default participation role을
    # 자동 시드한다 — 여기 직접 ORM construct는 그걸 건너뛰므로 명시 호출(안 하면
    # ensure_implementation_participation이 "default role 미시드"로 skip=False를 내
    # participation.ensured 검증이 실제 프로덕션 경로와 다른 값을 관측하게 된다).
    from app.services.participation_helpers import seed_default_participation_role
    await seed_default_participation_role(session, org.id)
    return org.id, project.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, title="Test Story", assignee_id=None):
    from app.models.pm import Story

    s = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, assignee_id=assignee_id)
    session.add(s)
    await session.commit()
    return s.id


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _setup_app(app, Session, *, org_id, user_id):
    from app.dependencies.auth import AuthContext, get_current_user

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        claims = {"app_metadata": {"api_key_id": "test-agent-key", "org_id": str(org_id)}}
        return AuthContext(user_id=str(user_id), email="agent@test", claims=claims)

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_claim_response_has_empty_assignee_ids_and_hint_when_unassigned():
    """AC1 — assignee 없는 스토리를 claim하면 assignee_ids=[]·hint 존재·
    assignee_changed=False·participation.ensured=True."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id, assignee_id=None)

        _setup_app(app, Session, org_id=org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/team-members/{agent_id}/claim", json={"story_id": str(story_id)},
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["claimed"] is True
        assert body["assignee_changed"] is False
        assert body["assignee_ids"] == []
        assert body["participation"]["ensured"] is True
        assert "hint" in body
        assert "assignee" in body["hint"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_claim_response_has_no_hint_when_assignee_already_set():
    """AC1 대칭절 — assignee가 이미 있으면 hint가 응답에서 아예 빠져야 한다(항상 켜진
    경고는 노이즈 — story 3414b6d7과 별개로 이미 알려진 것을 매번 다시 알리지 않는다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            other_member_id = uuid.uuid4()
            story_id = await _seed_story(s, org_id, project_id, assignee_id=other_member_id)

        _setup_app(app, Session, org_id=org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/team-members/{agent_id}/claim", json={"story_id": str(story_id)},
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["assignee_ids"] == [str(other_member_id)]
        assert "hint" not in body
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_claim_does_not_change_assignee_regression_3414b6d7():
    """story 3414b6d7 회귀 pin — claim_story가 assignee_id 컬럼 자체를 절대 안 건드린다
    (이 스토리는 신호만 고치지 그 결정을 재통합하지 않는다). claim한 agent 자신이
    assignee가 되는 일도 없어야 한다(합리적으로 오해하기 쉬운 방향이라 명시적으로 pin)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id, assignee_id=None)

        _setup_app(app, Session, org_id=org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/team-members/{agent_id}/claim", json={"story_id": str(story_id)},
            )
        assert r.status_code == 200, r.text

        async with Session() as s:
            from app.models.pm import Story
            story = await s.get(Story, story_id)
            assert story.assignee_id is None, "claim이 assignee_id를 채워선 안 된다(3414b6d7 결정)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
