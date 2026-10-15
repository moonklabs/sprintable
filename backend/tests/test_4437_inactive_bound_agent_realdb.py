"""story #4437 — a recipe stage bound to an agent that was stopped (its device disconnected · PR 4847) must not silently stall.

The stage-binding resolver (`event_routing_resolver._bound_member_for_stage`) did not look at `is_active`: events for that
stage queued for the inactive agent and the «no one reached» warning stayed off (Qadir 4847 ④ ⓐ). Now an inactive (or
missing) bound member resolves to «no one» — every caller of the resolver sees the same answer — and the connector-stage
fallback (the recipe's crew) leaves inactive members out too. The binding itself is kept (a new setup upserts it).

Harness: tests/test_4092_zero_reach_human_stage_notice_realdb.py (the recipe_role_binding + zero_reach seeds) as it is.
"""
from __future__ import annotations

import os
import uuid

from typing import TYPE_CHECKING

import pytest
from fastapi import BackgroundTasks

if TYPE_CHECKING:
    from starlette.requests import Request as StarletteRequest

    from app.dependencies.auth import AuthContext

from tests.recipe_stage_walk import prepare_stage_publish

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]

_DEFINITION_KEY = "org.acme.recipe_4437"

_PAYLOAD_SCHEMA = {
    "type": "object",
    "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": ["draft", "concept_confirmed"]},
        "work_item_id": {"type": "string", "format": "uuid"},
        "work_item_type": {"type": "string"},
    },
    "additionalProperties": False,
}
_ROUTING = {
    "broadcast": {"kind": "recipe_role_binding"},
    "escalation": {"kind": "server_derived", "target": "none"},
}
_STAGE_METADATA = {
    "draft": {"role": "Creator", "action": "초안 작성"},
    "concept_confirmed": {"role": "Director", "action": "컨셉 확定 승인"},
}
_ROLE_ACTOR_KINDS = {"Creator": "agent", "Director": "human"}


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


async def _seed_org_project(session, *, slug="s4437"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org4437", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="레시피 work item")
    session.add(story)
    await session.commit()
    return story.id


async def _seed_definition(session, org_id, *, role_actor_kinds=None):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=_DEFINITION_KEY, org_id=org_id, name="테스트 레시피",
        payload_schema=_PAYLOAD_SCHEMA, routing=_ROUTING, stage_metadata=_STAGE_METADATA,
        role_actor_kinds=role_actor_kinds,
    )
    session.add(d)
    await session.commit()
    return d


async def _seed_binding(session, org_id, project_id, *, stage, agent_id):
    from app.models.recipe_role_binding import RecipeRoleBinding

    session.add(RecipeRoleBinding(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id,
        event_definition_key=_DEFINITION_KEY, stage=stage, agent_member_id=agent_id,
    ))
    await session.commit()


async def _seed_human(session, org_id, *, locale=None):
    """story #4251 — 첫 stage를 바인딩 없이 내는 자리(«레시피 시작»)는 프로젝트에 접근할 수 있는 사람이다(org owner).
    story #4250 — `locale`은 소유자의 users.locale = 조직 기준 언어(`resolve_org_locale`)."""
    from app.models.project import OrgMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"human-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x", locale=locale)
    session.add(user)
    await session.commit()
    session.add(OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role="owner"))
    await session.commit()
    return user.id


def _human_auth(user_id: uuid.UUID, org_id: uuid.UUID) -> AuthContext:
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(org_id))


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> AuthContext:
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


def _fake_request(accept_language: str | None = None) -> StarletteRequest:
    from starlette.requests import Request as StarletteRequest
    headers = [(b"accept-language", accept_language.encode())] if accept_language else []
    return StarletteRequest(scope={"type": "http", "headers": headers})


async def _publish_stage(session, *, org_id, publisher_id, story_id, stage, human=False, accept_language=None):
    from app.routers.events import EventPublishRequest, publish_registry_event

    body = EventPublishRequest(
        definition_key=_DEFINITION_KEY,
        payload={"stage": stage, "work_item_type": "story", "work_item_id": str(story_id)},
    )
    return await publish_registry_event(
        body, BackgroundTasks(), _fake_request(accept_language), db=session,
        auth=_human_auth(publisher_id, org_id) if human else _auth(publisher_id, org_id), org_id=org_id,
    )




async def _deactivate(session, member_id):
    from sqlalchemy import update

    from app.models.team import TeamMember

    await session.execute(update(TeamMember).where(TeamMember.id == member_id).values(is_active=False))
    await session.commit()


async def _events_for(session, member_id) -> int:
    from sqlalchemy import func, select

    from app.models.event import Event

    return (await session.execute(select(func.count()).select_from(Event).where(Event.recipient_id == member_id))).scalar_one()


@pytest.mark.anyio
async def test_a_stage_bound_to_a_stopped_agent_reaches_no_one_and_warns():
    """AC1 — the draft stage is bound to an agent that was then stopped: publishing it queues nothing for that agent and the
    «no one reached» warning shows (before: the agent was a recipient and the warning stayed off)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id, role_actor_kinds=_ROLE_ACTOR_KINDS)
            owner_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            drafter_id = await _seed_agent(s, org_id, project_id, name="drafter")
            await _seed_binding(s, org_id, project_id, stage="draft", agent_id=drafter_id)
            await _deactivate(s, drafter_id)

            resp = await _publish_stage(s, org_id=org_id, publisher_id=owner_id, story_id=story_id, stage="draft", human=True)

            assert resp["broadcast_member_ids"] == [], resp
            assert resp["zero_reach_warning"] is True, resp
            assert "warning" in resp
            assert await _events_for(s, drafter_id) == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_stage_bound_to_an_active_agent_is_unchanged():
    """AC2 — the same stage with its agent active reaches that agent, no warning (no change)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id, role_actor_kinds=_ROLE_ACTOR_KINDS)
            owner_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            drafter_id = await _seed_agent(s, org_id, project_id, name="drafter")
            await _seed_binding(s, org_id, project_id, stage="draft", agent_id=drafter_id)

            resp = await _publish_stage(s, org_id=org_id, publisher_id=owner_id, story_id=story_id, stage="draft", human=True)

            assert resp["broadcast_member_ids"] == [str(drafter_id)], resp
            assert resp["zero_reach_warning"] is False, resp
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_stopped_agent_on_the_project_binding_does_not_fall_back_to_the_org_wide_one():
    """The project binding decides for its project (story #3288 order). When its agent is stopped the stage has no one —
    it does not quietly move to the org-wide binding's agent (project work would land somewhere nobody chose for it)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id, role_actor_kinds=_ROLE_ACTOR_KINDS)
            owner_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            project_agent = await _seed_agent(s, org_id, project_id, name="project drafter")
            org_agent = await _seed_agent(s, org_id, project_id, name="org drafter")
            await _seed_binding(s, org_id, project_id, stage="draft", agent_id=project_agent)
            await _seed_binding(s, org_id, None, stage="draft", agent_id=org_agent)
            await _deactivate(s, project_agent)

            resp = await _publish_stage(s, org_id=org_id, publisher_id=owner_id, story_id=story_id, stage="draft", human=True)

            assert resp["broadcast_member_ids"] == [], resp
            assert resp["zero_reach_warning"] is True, resp
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_every_caller_of_the_stage_resolver_sees_no_one_for_a_stopped_agent():
    """AC3 — the resolver is the one place every caller asks (delivery · the event card's stage assignee · recipe start
    candidates' current/next assignee · stage complete/start assignee checks · the channel-stage next member · the last server
    stage's bound agent · publish-failure notices). The resolver and the two that build recipient sets are checked directly;
    the crew fallback (connector stages) leaves stopped agents out too."""
    from app.services.event_routing_resolver import _bound_member_for_stage, recipe_crew_member_ids
    from app.services.recipe_publish_failure import RecipePublishFailureContext, recipe_publish_failure_recipients

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id, role_actor_kinds=_ROLE_ACTOR_KINDS)
            story_id = await _seed_story(s, org_id, project_id)
            stopped = await _seed_agent(s, org_id, project_id, name="stopped")
            active = await _seed_agent(s, org_id, project_id, name="active")
            await _seed_binding(s, org_id, project_id, stage="draft", agent_id=stopped)
            await _seed_binding(s, org_id, project_id, stage="concept_confirmed", agent_id=active)
            await _deactivate(s, stopped)

            kw = dict(org_id=org_id, project_id=project_id, definition_key=_DEFINITION_KEY)
            assert await _bound_member_for_stage(s, stage="draft", **kw) is None
            assert await _bound_member_for_stage(s, stage="concept_confirmed", **kw) == active
            assert await recipe_crew_member_ids(s, **kw) == {active}

            ctx = RecipePublishFailureContext(
                kind="channel_post", definition_key=_DEFINITION_KEY, request_stage="draft", work_item_type="story", work_item_id=story_id,
                approver_id=None,
            )
            assert await recipe_publish_failure_recipients(s, org_id=org_id, ctx=ctx) == set()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_person_bound_through_their_org_membership_still_counts():
    """A person bound to a stage by their org membership (no project row — e.g. an org owner) is still the stage's assignee:
    only a stopped agent or a member that is gone is «no one» (the first cut read only the team-member rows and dropped them —
    caught by test_4249's person-bound stages)."""
    from sqlalchemy import select

    from app.models.project import OrgMember
    from app.services.event_routing_resolver import _bound_member_for_stage

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id, role_actor_kinds=_ROLE_ACTOR_KINDS)
            owner_user = await _seed_human(s, org_id)
            owner_member = (await s.execute(select(OrgMember.id).where(OrgMember.user_id == owner_user))).scalar_one()
            await _seed_binding(s, org_id, project_id, stage="concept_confirmed", agent_id=owner_member)

            kw = dict(org_id=org_id, project_id=project_id, definition_key=_DEFINITION_KEY)
            assert await _bound_member_for_stage(s, stage="concept_confirmed", **kw) == owner_member

            from datetime import datetime, timezone

            from sqlalchemy import update

            await s.execute(update(OrgMember).where(OrgMember.id == owner_member).values(deleted_at=datetime.now(timezone.utc)))
            await s.commit()
            assert await _bound_member_for_stage(s, stage="concept_confirmed", **kw) is None  # left the org → no one
    finally:
        await engine.dispose()
