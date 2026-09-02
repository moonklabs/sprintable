"""story #3337(선생님 4바퀴 실사고, 페드루 PO 설계 확定 2026-09-02) — 사이클형 레시피 정의의
반복 주기(payload.repeat)를 "에이전트가 스스로 재는" 자율 행동이 아니라 제품이 다음 회차
stage 이벤트를 발행하는 서버 능력으로 만든다.

AC1 — repeat=PT10M 테스트 정의로 두 회차가 사람 손 0으로 발행됨(실 HTTP 왕복 대신 서비스
직접 호출 — 다른 realdb 스위트(test_3330/test_3340)와 동일 관례, publish_preset_event 자체가
이미 그 파이프의 실물이라 라우터 재왕복은 이 스위트의 관심사를 안 늘림)·회차 키 멱등(같은
tick 반복 호출해도 회차 1개)·중복 0.
AC2 — 정지 조건 3종(정의 비활성·project 삭제·연속실패 3회) 각각 발행 0 + 알림 1.

seed 하네스는 test_3330_gate_verdict_notification.py/test_3340_gate_verdict_notify_reach.py와
동일 패턴(파일별 로컬 중복이 이 스위트의 기존 관례)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema

_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    """test_3330와 동일 이유 — publish_preset_event()가 send_message()의 background task를
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


async def _seed_org_project_owner(session, *, slug="e3337"):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.team import TeamMember
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org3337", slug=slug)
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


async def _seed_system_publisher(session, org_id, project_id):
    from app.models.member import Member
    from app.models.team import TeamMember

    publisher_id = uuid.uuid4()
    session.add(Member(
        id=publisher_id, org_id=org_id, type="agent", name="시스템 발행",
        runtime_type="system-publisher", is_active=True,
    ))
    session.add(TeamMember(
        id=publisher_id, org_id=org_id, project_id=project_id, type="agent",
        name="시스템 발행", runtime_type="system-publisher", is_active=True,
    ))
    await session.commit()
    return publisher_id


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


async def _seed_cyclic_definition(session, *, org_id, key="org.e3337.cyclic", enabled=True):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=key, org_id=org_id, name="반복 테스트 정의",
        payload_schema=_CYCLIC_SCHEMA, routing=_NONE_ROUTING, stage_metadata=_STAGE_METADATA,
        enabled=enabled, version=1,
    )
    session.add(d)
    await session.commit()
    return d


async def _seed_story(session, org_id, project_id, *, assignee_id=None, title="회차 1"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, assignee_id=assignee_id)
    session.add(story)
    await session.commit()
    return story.id


async def _publish_first_collect(session, *, org_id, story_id, definition_key, repeat, requester_id=None):
    from app.dependencies.auth import AuthContext
    from app.routers.events import _publish_registry_event_core
    from fastapi import BackgroundTasks

    # requester_id는 TeamMember.id(에이전트) — api_key_id 마커로 agent 분기를 태운다
    # (member_resolver.py::_resolve_member_legacy, human/JWT 분기와 갈리는 지점).
    auth = AuthContext(
        user_id=str(requester_id or uuid.uuid4()), email=None,
        claims={"app_metadata": {"api_key_id": "test-agent"}}, org_id=str(org_id),
    )
    return await _publish_registry_event_core(
        session, org_id, auth, definition_key,
        {"work_item_type": "story", "work_item_id": str(story_id), "stage": "collect", "repeat": repeat},
        BackgroundTasks(),
    )


async def _count_stories(session, org_id) -> int:
    from sqlalchemy import func, select
    from app.models.pm import Story

    return (await session.execute(select(func.count()).select_from(Story).where(Story.org_id == org_id))).scalar_one()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_ac1_two_rounds_fire_with_zero_human_hands_and_tick_is_idempotent():
    from app.models.recipe_repeat_schedule import RecipeRepeatSchedule
    from app.services.recipe_repeat_scheduler import process_recipe_repeat_ticks
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner_id = await _seed_org_project_owner(s, slug="e3337a")
            await _seed_system_publisher(s, org_id, project_id)
            executor_id = await _seed_agent(s, org_id, project_id)
            definition = await _seed_cyclic_definition(s, org_id=org_id)
            story1_id = await _seed_story(s, org_id, project_id, assignee_id=executor_id, title="회차 1")

            # 회차 1 — 사람/에이전트가 손으로 발행(오늘 밤 4바퀴의 실제 시작 방식과 동형).
            await _publish_first_collect(
                s, org_id=org_id, story_id=story1_id, definition_key=definition.key,
                repeat="PT10M", requester_id=executor_id,
            )
            await s.commit()

            schedule = (await s.execute(
                select(RecipeRepeatSchedule).where(
                    RecipeRepeatSchedule.org_id == org_id, RecipeRepeatSchedule.definition_key == definition.key,
                )
            )).scalar_one()
            assert schedule.status == "active"
            assert schedule.last_story_id == story1_id
            first_next_run_at = schedule.next_run_at

            # 시간 경과 시뮬레이션 — next_run_at을 과거로 당긴다(실 10분 대기 대신).
            schedule.next_run_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            await s.commit()

            stories_before = await _count_stories(s, org_id)
            counts = await process_recipe_repeat_ticks(s)
            assert counts["fired"] == 1, counts
            stories_after = await _count_stories(s, org_id)
            assert stories_after == stories_before + 1, "회차 2 Story가 자동 생성되지 않았다(AC1 실패)"

            await s.refresh(schedule)
            assert schedule.status == "active"
            assert schedule.last_story_id != story1_id  # 새 Story로 갱신됨
            assert schedule.next_run_at > first_next_run_at  # 다음 회차로 전진(무한루프 아님)
            round2_next_run_at = schedule.next_run_at

            # 회차 2의 새 Story도 executor 배정을 승계했는지(#3340 도달 원칙 정합).
            from app.models.pm import Story
            round2_story = (await s.execute(
                select(Story).where(Story.id == schedule.last_story_id)
            )).scalar_one()
            assert round2_story.assignee_id == executor_id

            # 멱등 — next_run_at이 미래로 전진했으므로, 같은 tick을 즉시 재호출해도 회차가
            # 추가로 안 나간다("같은 tick 2회 실행돼도 회차 1개", 페드루 확定 AC4).
            counts2 = await process_recipe_repeat_ticks(s)
            assert counts2["fired"] == 0, counts2
            stories_final = await _count_stories(s, org_id)
            assert stories_final == stories_after, "멱등 위반 — 중복 회차가 발행됐다"
            await s.refresh(schedule)
            assert schedule.next_run_at == round2_next_run_at
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_ac2_definition_disabled_pauses_with_zero_publish_and_one_notification():
    from app.models.recipe_repeat_schedule import RecipeRepeatSchedule
    from app.services.recipe_repeat_scheduler import process_recipe_repeat_ticks
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s, slug="e3337b")
            publisher_id = await _seed_system_publisher(s, org_id, project_id)
            definition = await _seed_cyclic_definition(s, org_id=org_id, key="org.e3337b.cyclic")
            story_id = await _seed_story(s, org_id, project_id)
            await _publish_first_collect(s, org_id=org_id, story_id=story_id, definition_key=definition.key, repeat="PT10M", requester_id=publisher_id)
            await s.commit()

            definition.enabled = False
            schedule = (await s.execute(
                select(RecipeRepeatSchedule).where(RecipeRepeatSchedule.definition_key == definition.key)
            )).scalar_one()
            schedule.next_run_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            await s.commit()

            stories_before = await _count_stories(s, org_id)
            counts = await process_recipe_repeat_ticks(s)
            assert counts["fired"] == 0, counts
            assert counts["paused_definition_disabled"] == 1, counts
            assert await _count_stories(s, org_id) == stories_before

            await s.refresh(schedule)
            assert schedule.status == "paused"

            content = await _latest_dm_content_for(s, owner_id, org_id)
            assert content is not None, "정지 알림이 owner에게 도달하지 않았다"
            assert "정지" in content
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_ac2_project_deleted_pauses_with_zero_publish_and_one_notification():
    from app.models.recipe_repeat_schedule import RecipeRepeatSchedule
    from app.services.recipe_repeat_scheduler import process_recipe_repeat_ticks
    from app.models.project import Project
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s, slug="e3337c")
            publisher_id = await _seed_system_publisher(s, org_id, project_id)
            definition = await _seed_cyclic_definition(s, org_id=org_id, key="org.e3337c.cyclic")
            story_id = await _seed_story(s, org_id, project_id)
            await _publish_first_collect(s, org_id=org_id, story_id=story_id, definition_key=definition.key, repeat="PT10M", requester_id=publisher_id)
            await s.commit()

            project = (await s.execute(select(Project).where(Project.id == project_id))).scalar_one()
            project.deleted_at = datetime.now(timezone.utc)
            schedule = (await s.execute(
                select(RecipeRepeatSchedule).where(RecipeRepeatSchedule.definition_key == definition.key)
            )).scalar_one()
            schedule.next_run_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            await s.commit()

            stories_before = await _count_stories(s, org_id)
            counts = await process_recipe_repeat_ticks(s)
            assert counts["fired"] == 0, counts
            assert counts["paused_project_deleted"] == 1, counts
            assert await _count_stories(s, org_id) == stories_before

            await s.refresh(schedule)
            assert schedule.status == "paused"

            content = await _latest_dm_content_for(s, owner_id, org_id)
            assert content is not None
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_ac2_three_consecutive_failures_pauses_with_zero_publish_and_one_notification():
    """연속 실패 3회 — payload_schema를 스냅샷이 못 채우는 required 필드(channel)로 걸어
    매 tick 발행이 InvalidEventPayloadError로 실패하게 강제한다. 실패는 next_run_at을 안
    전진시키므로(성공 경로만 훅이 전진시킴) 다음 tick이 곧바로 같은 행을 재시도한다."""
    from app.models.recipe_repeat_schedule import RecipeRepeatSchedule
    from app.services.recipe_repeat_scheduler import process_recipe_repeat_ticks
    from app.models.event_definition import EventDefinition
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s, slug="e3337d")
            publisher_id = await _seed_system_publisher(s, org_id, project_id)
            definition = await _seed_cyclic_definition(s, org_id=org_id, key="org.e3337d.cyclic")
            story_id = await _seed_story(s, org_id, project_id)
            await _publish_first_collect(s, org_id=org_id, story_id=story_id, definition_key=definition.key, repeat="PT10M", requester_id=publisher_id)
            await s.commit()

            # 정의를 "channel 필수"로 바꿔 이후 모든 재발행이 거부되게 만든다(스냅샷엔
            # channel이 없다 — 최초 발행이 channel을 안 실었으므로).
            required = list(_CYCLIC_SCHEMA["required"]) + ["channel"]
            strict_schema = {**_CYCLIC_SCHEMA, "required": required}
            d = (await s.execute(select(EventDefinition).where(EventDefinition.id == definition.id))).scalar_one()
            d.payload_schema = strict_schema
            schedule = (await s.execute(
                select(RecipeRepeatSchedule).where(RecipeRepeatSchedule.definition_key == definition.key)
            )).scalar_one()
            schedule.next_run_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            await s.commit()

            stories_before = await _count_stories(s, org_id)
            for _ in range(3):
                await process_recipe_repeat_ticks(s)

            assert await _count_stories(s, org_id) == stories_before, "실패 발행인데 Story가 남았다(부분 커밋 누수)"
            await s.refresh(schedule)
            assert schedule.consecutive_failure_count == 3
            assert schedule.status == "paused"

            content = await _latest_dm_content_for(s, owner_id, org_id)
            assert content is not None
            assert "3회" in content
    finally:
        await engine.dispose()


async def _latest_dm_content_for(session, member_id, org_id):
    from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant
    from sqlalchemy import select

    row = (await session.execute(
        select(ConversationMessage)
        .join(ConversationParticipant, ConversationParticipant.conversation_id == ConversationMessage.conversation_id)
        .join(Conversation, Conversation.id == ConversationMessage.conversation_id)
        .where(ConversationParticipant.member_id == member_id, Conversation.org_id == org_id)
        .order_by(ConversationMessage.created_at.desc())
        .limit(1)
    )).scalar_one_or_none()
    return row.content if row is not None else None
