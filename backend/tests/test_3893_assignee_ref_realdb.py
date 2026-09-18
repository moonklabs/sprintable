"""story #3893(E-UX-OVERHAUL·§⑤·Chat, PO 확定 2026-09-14) — 대화 이벤트 카드
`preset.work.assigned`의 담당자·배정자(assignee_member_id/assigned_by_member_id, raw
UUID)를 발행 시점에 표시 이름으로 해석한다.

story #3332가 `work_item_type`/`work_item_id` 페어를 `refs.work_item`으로 계산하는
자리(`_publish_registry_event_core`)를 realdb로 검증한 것과 동형 패턴 — 여기는
`assignee_member_id`/`assigned_by_member_id`가 같은 자리에서 `refs.assignee`/
`refs.assigned_by`로 계산되는지 검증한다(새 발행 갈래 0 — publish_registry_event를
직접 호출해 이 계산 로직 자체만 격리 검증, `_render_event_notification_member_ref`
자체의 분기 로직은 별도 mock 단위테스트(test_3893_member_ref_unit.py)가 커버).
"""
from __future__ import annotations

import uuid

import pytest

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema

_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")

_WORK_ASSIGNED_PAYLOAD_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["work_item_type", "work_item_id", "assignee_member_id"],
    "properties": {
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
        "assignee_member_id": {"type": "string", "format": "uuid"},
        "assigned_by_member_id": {"type": ["string", "null"], "format": "uuid"},
    },
}
_WORK_ASSIGNED_ROUTING = {
    "escalation": {
        "kind": "payload_field", "target": "assignee", "member_id_field": "assignee_member_id",
    },
    "broadcast": {
        "kind": "server_derived", "target": "work_item_stakeholders",
        "inherit_conversation_scope": True,
    },
}


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    """test_3332/test_2637_event_msg_metadata_tagging와 동형 표준 방어 fixture(story
    a05da51b) — publish_registry_event가 send_message의 background task를 통해 전역
    엔진(app.core.database.engine)을 쓰므로, 이 파일의 throwaway 엔진과 별개로 dispose
    필수(안 하면 다음 테스트에서 `Event loop is closed` 누수 재현)."""
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


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


async def _seed_org_with_owner(session, *, slug="e3893"):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.team import TeamMember
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org3893", slug=slug)
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


async def _seed_story(session, org_id, project_id, *, assignee_id, title="Threads 포스트 초안"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, assignee_id=assignee_id)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_system_publisher(session, org_id, project_id):
    """test_3332와 동형 우회 — Base.metadata.create_all 스키마엔 team_members가(프로덕션의
    members/project_access 위 VIEW와 달리) 독립 테이블이라 미리 심어야
    `_get_or_create_system_publisher`가 있는 걸 찾는다."""
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


async def _seed_preset_work_assigned_definition(session):
    from app.models.event_definition import EventDefinition
    from sqlalchemy import select

    existing = (await session.execute(
        select(EventDefinition).where(
            EventDefinition.key == "preset.work.assigned", EventDefinition.org_id.is_(None),
        )
    )).scalar_one_or_none()
    if existing is not None:
        return
    session.add(EventDefinition(
        id=uuid.uuid4(), key="preset.work.assigned", org_id=None,
        payload_schema=_WORK_ASSIGNED_PAYLOAD_SCHEMA, routing=_WORK_ASSIGNED_ROUTING,
        enabled=True, version=1,
    ))
    await session.commit()


def _auth(agent_id, org_id):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_publish_computes_assignee_and_assigned_by_refs():
    """work_item(story #3332 재확認)·assignee·assigned_by 3종이 한 발행에서 동시에
    계산된다 — 서로 다른 payload 필드가 서로 다른 리졸버로 독립 해소됨을 확인."""
    from app.routers.events import EventPublishRequest, publish_registry_event
    from fastapi import BackgroundTasks
    from starlette.requests import Request as StarletteRequest

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_with_owner(s, slug="e3893a")
            await _seed_preset_work_assigned_definition(s)
            await _seed_system_publisher(s, org_id, project_id)
            assignee_id = await _seed_agent(s, org_id, project_id, name="미르코")
            assigner_id = await _seed_agent(s, org_id, project_id, name="페드루")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=assignee_id)

            resp = await publish_registry_event(
                EventPublishRequest(
                    definition_key="preset.work.assigned",
                    payload={
                        "work_item_type": "story", "work_item_id": str(story_id),
                        "assignee_member_id": str(assignee_id),
                        "assigned_by_member_id": str(assigner_id),
                    },
                ),
                BackgroundTasks(), StarletteRequest(scope={"type": "http", "headers": []}),
                db=s, auth=_auth(assigner_id, org_id), org_id=org_id,
            )
            await s.commit()

            from app.models.conversation import ConversationMessage
            from sqlalchemy import select

            msg = (await s.execute(
                select(ConversationMessage).where(ConversationMessage.id == uuid.UUID(resp["message_id"]))
            )).scalar_one()
            refs = (msg.msg_metadata or {}).get("event", {}).get("refs") or {}
            assert refs.get("work_item") == {
                "found": True,
                "token": f"[Threads 포스트 초안](entity:story:{story_id})",
            }
            assert refs.get("assignee") == {"found": True, "name": "미르코"}
            assert refs.get("assigned_by") == {"found": True, "name": "페드루"}
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_publish_assignee_ref_found_false_when_member_deleted():
    """탈퇴·삭제된 member_id를 참조하면 raw id를 지어내지 않고 found:False로 떨어진다
    (targetMissing과 동일 원칙 — `_render_event_notification_member_ref` 계약)."""
    from app.routers.events import EventPublishRequest, publish_registry_event
    from fastapi import BackgroundTasks
    from starlette.requests import Request as StarletteRequest

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_with_owner(s, slug="e3893b")
            await _seed_preset_work_assigned_definition(s)
            await _seed_system_publisher(s, org_id, project_id)
            assignee_id = await _seed_agent(s, org_id, project_id, name="유령")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=assignee_id)
            nonexistent_assigner_id = uuid.uuid4()  # 실존하지 않는 member_id.

            resp = await publish_registry_event(
                EventPublishRequest(
                    definition_key="preset.work.assigned",
                    payload={
                        "work_item_type": "story", "work_item_id": str(story_id),
                        "assignee_member_id": str(assignee_id),
                        "assigned_by_member_id": str(nonexistent_assigner_id),
                    },
                ),
                BackgroundTasks(), StarletteRequest(scope={"type": "http", "headers": []}),
                db=s, auth=_auth(assignee_id, org_id), org_id=org_id,
            )
            await s.commit()

            from app.models.conversation import ConversationMessage
            from sqlalchemy import select

            msg = (await s.execute(
                select(ConversationMessage).where(ConversationMessage.id == uuid.UUID(resp["message_id"]))
            )).scalar_one()
            refs = (msg.msg_metadata or {}).get("event", {}).get("refs") or {}
            assert refs.get("assignee") == {"found": True, "name": "유령"}
            assert refs.get("assigned_by") == {"found": False}
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_publish_assignee_ref_absent_when_payload_lacks_assignee_field():
    """assignee_member_id가 없는 payload(다른 preset)는 refs에 assignee 키 자체가 없다
    (work_item_pair 부재 시 refs.work_item이 없는 것과 동일 원칙, test_3332 회귀 확認).
    CHANGES②(PO PR#4298 리뷰 2026-09-15) — 같은 발행이 `goal_id`를 실었으므로 이제
    `refs["goal"]`도 계산된다(epic 갈래 신설, `_render_event_notification_work_item_ref`
    재사용) — assignee/assigned_by 부재와 goal 계산이 서로 독립임을 같은 발행으로 확認."""
    from app.routers.events import EventPublishRequest, publish_registry_event
    from fastapi import BackgroundTasks
    from starlette.requests import Request as StarletteRequest

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_with_owner(s, slug="e3893c")
            await _seed_system_publisher(s, org_id, project_id)

            from app.models.event_definition import EventDefinition
            from app.models.pm import Goal

            s.add(EventDefinition(
                id=uuid.uuid4(), key="preset.goal.measured", org_id=None,
                payload_schema={
                    "type": "object", "additionalProperties": False,
                    "required": ["goal_id", "metric_value"],
                    "properties": {
                        "goal_id": {"type": "string", "format": "uuid"},
                        "metric_value": {"type": "number"},
                    },
                },
                routing={
                    "escalation": {"kind": "server_derived", "target": "none"},
                    "broadcast": {"kind": "server_derived", "target": "goal_owner", "inherit_conversation_scope": False},
                },
                enabled=True, version=1,
            ))
            await s.commit()
            goal = Goal(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="측정 목표")
            s.add(goal)
            await s.commit()

            resp = await publish_registry_event(
                EventPublishRequest(
                    definition_key="preset.goal.measured",
                    payload={"goal_id": str(goal.id), "metric_value": 3},
                ),
                BackgroundTasks(), StarletteRequest(scope={"type": "http", "headers": []}),
                db=s, auth=_auth(owner_id, org_id), org_id=org_id,
            )
            from app.models.conversation import ConversationMessage
            from sqlalchemy import select

            msg = (await s.execute(
                select(ConversationMessage).where(ConversationMessage.id == uuid.UUID(resp["message_id"]))
            )).scalar_one()
            refs = (msg.msg_metadata or {}).get("event", {}).get("refs") or {}
            assert "assignee" not in refs
            assert "assigned_by" not in refs
            assert refs.get("goal") == {
                "found": True,
                "token": f"[측정 목표](entity:epic:{goal.id})",
            }
    finally:
        await engine.dispose()


# 「못 찾음」(found:False) 갈래는 realdb로 재현 불가 — `_resolve_event_project_id`가
# goal_id로 project_id를 먼저 해소하는데(같은 org_id+id 쿼리), 존재하지 않는 goal_id는
# 이 단계에서 이미 400(payload에서 project를 해소할 수 없습니다)으로 거부돼 refs 계산
# 자체에 도달하지 못한다(발행 파이프라인의 구조적 제약, work_item과 다른 점 — work_item은
# 소프트삭제로 "존재하되 못 찾음"이 자연스러운데 goal_id는 project 해소와 결합돼 있다).
# 이 갈래는 test_3893_epic_ref_unit.py::test_epic_not_found_returns_found_false_with_type
# (mock DB로 리졸버 함수 자체만 격리 검증)가 이미 커버 — 3884가 세운 "edge 갈래는 unit,
# happy path는 realdb 통합"과 동일 분업.
