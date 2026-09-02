"""story #3349(실사고 2026-09-02 14:56Z, 배포 4회차 직후 라이브) — 사이클형 레시피 정의를
«다른 work item»이 병렬로 발행하면(예: QA 테스트 스토리의 approve 발행) recipe_repeat_schedules
행이 (org, project, definition_key) 유니크 키만으로 그 work item을 "같은 회차"로 착각해
last_story_id/snapshot을 덮어쓴다 — 다음 회차가 엉뚱한 스토리의 assignee·산출물을 승계한다.

처방(페드루 확定, story 본문 그대로):
1. 첫 stage 아닌 발행은 payload.work_item_id == schedule.last_story_id일 때만 스냅샷 갱신
   (같은 회차). 다른 work item이면 무시(로그 1줄).
2. 첫 stage 발행(repeat 포함)은 현행(새 회차 시작 = 덮어쓰기가 맞음) 유지.

회귀 (a)(b)(c) — story 본문 그대로:
(a) 병렬 work item의 중간 stage 발행 → 행 무변
(b) 같은 회차 measure 발행 → snapshot 갱신
(c) 새 회차 collect+repeat → last_story_id 교체

seed 하네스는 test_3337_recipe_repeat_scheduler.py와 동일 패턴(파일별 로컬 중복이 이 스위트의
기존 관례)."""
from __future__ import annotations

import uuid

import pytest

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema

_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    """test_3337와 동일 이유 — publish_preset_event()가 send_message()의 background task를
    태우고, 그 task는 전역 엔진(app.core.database.async_session_factory)을 쓴다."""
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _realdb_session():
    from sqlalchemy import text as sa_text
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
        await conn.execute(sa_text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_members_org_system_publisher "
            "ON members (org_id) WHERE (runtime_type = 'system-publisher' AND type = 'agent')"
        ))
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_project_owner(session, *, slug="e3349"):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.team import TeamMember
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org3349", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    owner_user = User(id=uuid.uuid4(), email=f"owner-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add(owner_user)
    await session.commit()
    owner_member = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=owner_user.id, role="owner")
    session.add(owner_member)
    await session.commit()
    session.add(TeamMember(
        id=owner_member.id, org_id=org.id, project_id=project.id, type="human", name="owner", is_active=True,
    ))
    await session.commit()
    return org.id, project.id, owner_member.id


async def _seed_agent(session, org_id, project_id, *, name="executor"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


_CYCLIC_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["work_item_type", "work_item_id", "stage"],
    "properties": {
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
        "stage": {"type": "string", "enum": ["collect", "measure"]},
        "repeat": {"type": "string"},
        "channel": {"type": "string"},
        "previous_output_doc_id": {"type": "string"},
    },
}
_STAGE_METADATA = {
    "collect": {"role": "Collector", "action": "수집"},
    "measure": {"role": "Measurer", "action": "측정"},
}
_NONE_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {"kind": "server_derived", "target": "none"},
}


async def _seed_cyclic_definition(session, *, org_id, key="org.e3349.cyclic"):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=key, org_id=org_id, name="반복 테스트 정의",
        payload_schema=_CYCLIC_SCHEMA, routing=_NONE_ROUTING, stage_metadata=_STAGE_METADATA,
        enabled=True, version=1,
    )
    session.add(d)
    await session.commit()
    return d


async def _seed_story(session, org_id, project_id, *, assignee_id=None, title="회차"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, assignee_id=assignee_id)
    session.add(story)
    await session.commit()
    return story.id


async def _publish_stage(session, *, org_id, story_id, definition_key, stage, requester_id, repeat=None, channel=None):
    from app.dependencies.auth import AuthContext
    from app.routers.events import _publish_registry_event_core
    from fastapi import BackgroundTasks

    payload = {"work_item_type": "story", "work_item_id": str(story_id), "stage": stage}
    if repeat is not None:
        payload["repeat"] = repeat
    if channel is not None:
        payload["channel"] = channel
    auth = AuthContext(
        user_id=str(requester_id), email=None,
        claims={"app_metadata": {"api_key_id": "test-agent"}}, org_id=str(org_id),
    )
    return await _publish_registry_event_core(session, org_id, auth, definition_key, payload, BackgroundTasks())


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_a_parallel_work_item_mid_stage_publish_leaves_row_unchanged():
    from app.models.recipe_repeat_schedule import RecipeRepeatSchedule
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner_id = await _seed_org_project_owner(s, slug="e3349a")
            executor_id = await _seed_agent(s, org_id, project_id)
            definition = await _seed_cyclic_definition(s, org_id=org_id)
            story1_id = await _seed_story(s, org_id, project_id, assignee_id=executor_id, title="회차 1")
            other_story_id = await _seed_story(s, org_id, project_id, title="QA 테스트 스토리")

            await _publish_stage(
                s, org_id=org_id, story_id=story1_id, definition_key=definition.key,
                stage="collect", requester_id=executor_id, repeat="P7D", channel="slack:#launch",
            )
            await s.commit()

            schedule = (await s.execute(
                select(RecipeRepeatSchedule).where(RecipeRepeatSchedule.definition_key == definition.key)
            )).scalar_one()
            assert schedule.last_story_id == story1_id
            snapshot_before = dict(schedule.last_payload_snapshot)

            # 실사고 재현 — 무관한 다른 work item(QA 테스트 스토리)이 같은 정의의 non-first
            # stage를 발행.
            await _publish_stage(
                s, org_id=org_id, story_id=other_story_id, definition_key=definition.key,
                stage="measure", requester_id=executor_id, channel="slack:#qa-noise",
            )
            await s.commit()

            await s.refresh(schedule)
            assert schedule.last_story_id == story1_id, "다른 work item의 발행이 last_story_id를 덮었다(회귀)"
            assert schedule.last_payload_snapshot == snapshot_before, "다른 work item의 발행이 snapshot을 덮었다(회귀)"
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_b_same_cycle_measure_publish_updates_snapshot():
    from app.models.recipe_repeat_schedule import RecipeRepeatSchedule
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner_id = await _seed_org_project_owner(s, slug="e3349b")
            executor_id = await _seed_agent(s, org_id, project_id)
            definition = await _seed_cyclic_definition(s, org_id=org_id)
            story1_id = await _seed_story(s, org_id, project_id, assignee_id=executor_id, title="회차 1")

            await _publish_stage(
                s, org_id=org_id, story_id=story1_id, definition_key=definition.key,
                stage="collect", requester_id=executor_id, repeat="P7D", channel="slack:#launch",
            )
            await s.commit()

            # 같은 회차(story1)의 measure 발행 — snapshot이 최신 channel로 갱신돼야 한다.
            await _publish_stage(
                s, org_id=org_id, story_id=story1_id, definition_key=definition.key,
                stage="measure", requester_id=executor_id, channel="slack:#measure-result",
            )
            await s.commit()

            schedule = (await s.execute(
                select(RecipeRepeatSchedule).where(RecipeRepeatSchedule.definition_key == definition.key)
            )).scalar_one()
            assert schedule.last_story_id == story1_id
            assert schedule.last_payload_snapshot["channel"] == "slack:#measure-result", "같은 회차 재발행인데 snapshot이 최신화 안 됐다(회귀)"
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_c_new_cycle_collect_with_repeat_replaces_last_story_id():
    from app.models.recipe_repeat_schedule import RecipeRepeatSchedule
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner_id = await _seed_org_project_owner(s, slug="e3349c")
            executor_id = await _seed_agent(s, org_id, project_id)
            definition = await _seed_cyclic_definition(s, org_id=org_id)
            story1_id = await _seed_story(s, org_id, project_id, assignee_id=executor_id, title="회차 1")
            story2_id = await _seed_story(s, org_id, project_id, assignee_id=executor_id, title="회차 2")

            await _publish_stage(
                s, org_id=org_id, story_id=story1_id, definition_key=definition.key,
                stage="collect", requester_id=executor_id, repeat="P7D",
            )
            await s.commit()

            # 새 회차 — 다른 work item(story2)이 collect+repeat로 발행하면 이건 진짜 새 회차
            # 시작이므로 last_story_id가 교체돼야 한다(guard가 이 경로를 막으면 안 됨).
            await _publish_stage(
                s, org_id=org_id, story_id=story2_id, definition_key=definition.key,
                stage="collect", requester_id=executor_id, repeat="P7D",
            )
            await s.commit()

            schedule = (await s.execute(
                select(RecipeRepeatSchedule).where(RecipeRepeatSchedule.definition_key == definition.key)
            )).scalar_one()
            assert schedule.last_story_id == story2_id, "새 회차 collect+repeat 발행인데 last_story_id가 교체 안 됐다(guard 과잉적용)"
    finally:
        await engine.dispose()
