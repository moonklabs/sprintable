"""story c7abdf42(2026-09-02, PO 확定) — 반복 스케줄 프로젝트 설정 화면용 API
(recipe_repeat_schedules.py) 실왕복 검증.

AC — list(project owner/org admin만)·run-now(스케줄러 tick과 같은 코드 경로,
FOR UPDATE NOWAIT 경합 방어)·resume(failure_count 0·pause_reason 클리어)·
pause(수동 중지 사유 영속)·전부 403(plain member).

seed 하네스는 test_3337_recipe_repeat_scheduler.py와 동일 패턴(파일별 로컬 중복이 이
스위트의 기존 관례)."""
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
    """test_3337과 동일 이유 — run-now가 publish_preset_event 경로를 태워 전역 엔진을 쓴다."""
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


async def _seed_org_project_owner(session, *, slug="ec7ab"):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.team import TeamMember
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="OrgC7ab", slug=slug)
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
    # get_project_role()은 org_members.user_id로 조회한다(휴먼 JWT user_id 축) — auth 액터로
    # 쓸 건 owner_member.id가 아니라 owner_user.id(project_auth.py 실측 확認, 이 파일 자체 발견).
    return org.id, project.id, owner_user.id


async def _seed_plain_member(session, org_id, project_id):
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.team import TeamMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"member-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role="member")
    session.add(om)
    await session.commit()
    session.add(TeamMember(id=om.id, org_id=org_id, project_id=project_id, type="human", name="member", is_active=True))
    session.add(ProjectAccess(id=uuid.uuid4(), project_id=project_id, org_member_id=om.id, member_id=om.id, permission="granted", role="member"))
    await session.commit()
    return user.id


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
_STAGE_METADATA = {"collect": {"role": "Collector", "action": "수집"}, "measure": {"role": "Measurer", "action": "측정"}}
_NONE_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {"kind": "server_derived", "target": "none"},
}


async def _seed_cyclic_definition(session, *, org_id, key="org.ec7ab.cyclic", enabled=True, name="반복 테스트 정의"):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=key, org_id=org_id, name=name,
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

    auth = AuthContext(
        user_id=str(requester_id or uuid.uuid4()), email=None,
        claims={"app_metadata": {"api_key_id": "test-agent"}}, org_id=str(org_id),
    )
    return await _publish_registry_event_core(
        session, org_id, auth, definition_key,
        {"work_item_type": "story", "work_item_id": str(story_id), "stage": "collect", "repeat": repeat},
        BackgroundTasks(),
    )


def _auth(user_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user_id), email="x@example.com", claims={}, org_id=str(org_id))


async def _seed_schedule_row(session, org_id, project_id):
    """스케줄러를 실제로 태워(회차 1 발행) 진짜 upsert 경로로 행을 만든다 — 합성 INSERT
    대신, 이 스토리가 소비하는 컬럼(last_story_id·last_payload_snapshot 등)이 실제로
    #3337 훅이 채우는 그대로임을 보장한다."""
    from app.models.recipe_repeat_schedule import RecipeRepeatSchedule
    from sqlalchemy import select

    executor_id = await _seed_agent(session, org_id, project_id)
    definition = await _seed_cyclic_definition(session, org_id=org_id)
    story_id = await _seed_story(session, org_id, project_id, assignee_id=executor_id, title="회차 1")
    await _publish_first_collect(
        session, org_id=org_id, story_id=story_id, definition_key=definition.key,
        repeat="PT10M", requester_id=executor_id,
    )
    await session.commit()
    schedule = (await session.execute(
        select(RecipeRepeatSchedule).where(
            RecipeRepeatSchedule.org_id == org_id, RecipeRepeatSchedule.definition_key == definition.key,
        )
    )).scalar_one()
    return schedule, definition, story_id


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_list_returns_row_with_definition_title_and_last_story_token():
    from app.routers.recipe_repeat_schedules import list_repeat_schedules

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s, slug="ec7ab1")
            await _seed_system_publisher(s, org_id, project_id)
            schedule, definition, story_id = await _seed_schedule_row(s, org_id, project_id)

            rows = await list_repeat_schedules(project_id, auth=_auth(owner_id, org_id), session=s)
            assert len(rows) == 1
            row = rows[0]
            assert row.definition_key == definition.key
            assert row.definition_title == "반복 테스트 정의"
            assert row.status == "active"
            assert row.last_story_reference_token is not None
            assert f"entity:story:{story_id}" in row.last_story_reference_token
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_list_forbidden_for_plain_member():
    from fastapi import HTTPException
    from app.routers.recipe_repeat_schedules import list_repeat_schedules

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s, slug="ec7ab2")
            await _seed_system_publisher(s, org_id, project_id)
            await _seed_schedule_row(s, org_id, project_id)
            member_id = await _seed_plain_member(s, org_id, project_id)

            with pytest.raises(HTTPException) as exc:
                await list_repeat_schedules(project_id, auth=_auth(member_id, org_id), session=s)
            assert exc.value.status_code == 403
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_run_now_fires_new_cycle_via_shared_scheduler_function():
    """⭐AC — «지금 한 회차»가 스케줄러 tick과 같은 결과(새 Story+회차 전진)를 낸다."""
    from app.routers.recipe_repeat_schedules import run_repeat_schedule_now
    from sqlalchemy import func, select
    from app.models.pm import Story

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s, slug="ec7ab3")
            await _seed_system_publisher(s, org_id, project_id)
            schedule, definition, story1_id = await _seed_schedule_row(s, org_id, project_id)
            stories_before = (await s.execute(select(func.count()).select_from(Story).where(Story.org_id == org_id))).scalar_one()

            result = await run_repeat_schedule_now(
                project_id, schedule.id, auth=_auth(owner_id, org_id), session=s,
            )

            assert result.status == "active"
            stories_after = (await s.execute(select(func.count()).select_from(Story).where(Story.org_id == org_id))).scalar_one()
            assert stories_after == stories_before + 1, "run-now가 새 회차 Story를 안 만들었다"
            assert result.last_story_reference_token is not None
            assert f"entity:story:{story1_id}" not in result.last_story_reference_token, "직전 회차 story로 그대로 남아있음(갱신 안 됨)"
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_run_now_forbidden_for_plain_member():
    from fastapi import HTTPException
    from app.routers.recipe_repeat_schedules import run_repeat_schedule_now

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s, slug="ec7ab4")
            await _seed_system_publisher(s, org_id, project_id)
            schedule, _definition, _story_id = await _seed_schedule_row(s, org_id, project_id)
            member_id = await _seed_plain_member(s, org_id, project_id)

            with pytest.raises(HTTPException) as exc:
                await run_repeat_schedule_now(project_id, schedule.id, auth=_auth(member_id, org_id), session=s)
            assert exc.value.status_code == 403
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_resume_resets_failure_count_and_clears_pause_reason():
    from app.routers.recipe_repeat_schedules import resume_repeat_schedule
    from sqlalchemy import select
    from app.models.recipe_repeat_schedule import RecipeRepeatSchedule

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s, slug="ec7ab5")
            await _seed_system_publisher(s, org_id, project_id)
            schedule, _definition, _story_id = await _seed_schedule_row(s, org_id, project_id)
            # 정지 상태 시뮬레이션(스케줄러가 실제로 만드는 상태와 동형).
            schedule.status = "paused"
            schedule.pause_reason = "연속 3회 발행 실패"
            schedule.consecutive_failure_count = 3
            await s.commit()

            result = await resume_repeat_schedule(project_id, schedule.id, auth=_auth(owner_id, org_id), session=s)

            assert result.status == "active"
            assert result.pause_reason is None
            assert result.consecutive_failure_count == 0
            fresh = (await s.execute(select(RecipeRepeatSchedule).where(RecipeRepeatSchedule.id == schedule.id))).scalar_one()
            assert fresh.status == "active"
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_pause_sets_status_and_manual_reason():
    from app.routers.recipe_repeat_schedules import pause_repeat_schedule

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s, slug="ec7ab6")
            await _seed_system_publisher(s, org_id, project_id)
            schedule, _definition, _story_id = await _seed_schedule_row(s, org_id, project_id)
            assert schedule.status == "active"

            result = await pause_repeat_schedule(project_id, schedule.id, auth=_auth(owner_id, org_id), session=s)

            assert result.status == "paused"
            assert result.pause_reason == "수동으로 중지되었습니다"
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_resume_and_pause_forbidden_for_plain_member():
    from fastapi import HTTPException
    from app.routers.recipe_repeat_schedules import pause_repeat_schedule, resume_repeat_schedule

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s, slug="ec7ab7")
            await _seed_system_publisher(s, org_id, project_id)
            schedule, _definition, _story_id = await _seed_schedule_row(s, org_id, project_id)
            member_id = await _seed_plain_member(s, org_id, project_id)

            with pytest.raises(HTTPException) as exc1:
                await pause_repeat_schedule(project_id, schedule.id, auth=_auth(member_id, org_id), session=s)
            assert exc1.value.status_code == 403

            with pytest.raises(HTTPException) as exc2:
                await resume_repeat_schedule(project_id, schedule.id, auth=_auth(member_id, org_id), session=s)
            assert exc2.value.status_code == 403
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_scheduler_pause_reasons_now_persisted_on_row():
    """⭐story c7abdf42 AC① — 정지 사유가 정지 그 순간에 영속된다(휘발 DM만 남던 예전과 정정
    pin). test_3337의 정의-비활성 정지 시나리오를 재현하되, 이번엔 pause_reason 컬럼을 본다."""
    from app.services.recipe_repeat_scheduler import process_recipe_repeat_ticks
    from sqlalchemy import select
    from app.models.recipe_repeat_schedule import RecipeRepeatSchedule

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s, slug="ec7ab8")
            await _seed_system_publisher(s, org_id, project_id)
            schedule, definition, _story_id = await _seed_schedule_row(s, org_id, project_id)

            definition.enabled = False
            schedule.next_run_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            await s.commit()

            counts = await process_recipe_repeat_ticks(s)
            assert counts["paused_definition_disabled"] == 1, counts

            fresh = (await s.execute(select(RecipeRepeatSchedule).where(RecipeRepeatSchedule.id == schedule.id))).scalar_one()
            assert fresh.status == "paused"
            assert fresh.pause_reason == "정의가 비활성화되었거나 삭제되었습니다"
    finally:
        await engine.dispose()
