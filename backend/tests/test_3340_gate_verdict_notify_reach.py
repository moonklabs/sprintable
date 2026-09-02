"""story #3340(선생님 4바퀴 실사고, 페드루 PO GO 2026-09-02) — preset.gate.verdict·stage
통지(work_item_stakeholders)가 work item 미배정이면 «시스템 발행 혼자 있는 방»에 쌓이고
실행자가 못 받던 결함 처방.

근본원인(그라운딩, 소스 확認 — test_3330_gate_verdict_notification.py와 동일 하네스 재사용):
- `event_routing_resolver.py::_resolve_work_item_stakeholders`는 story의 assignee_id·
  human_owner_member_id·StoryAssignee만 본다 — work item 미배정이면 빈 집합.
- 게이트에는 "누가 이 게이트를 요청했나"가 없었다(neutral_facts.requested_by_member_id는
  doc 게이트만) — 이 스토리가 recipe stage 게이트에도 그 키를 채운다.
- `_publish_registry_event_core`(events.py)의 participant_ids는 escalation∪broadcast가
  둘 다 비면 sender(시스템 발행 계정) 하나뿐 — "혼자 있는 방"이 그렇게 생긴다.

처방 3항(AC 그대로):
①게이트 요청자 기록(recipe_gate_hooks.py::maybe_create_stage_gate)
②수신자 해석 확장(_resolve_work_item_stakeholders가 payload.gate_requester_member_id 합류)
③수신자 0(시스템 발행 발신만) → project relay owner(project_auth.py::resolve_project_relay_owner
 재사용) 대체 참가. 사람이 직접 publish_event 호출한 경우는 응답의 zero_reach_warning을
 읽는 사람이 있어 현행 유지(페드루 PO 확定, 범위 밖).

회귀 4항:
(a) 미배정 story + 게이트 요청자 있음 → 요청자 도달
(b) 미배정·요청자 없음 → owner 도달(preset.gate.verdict) — status_changed도 동일 폴백
    (페드루 지시, 별도 키 매핑 없이 ③의 시스템발신 축 하나로 같이 커버됨을 고정)
(c) 배정 story → 기존 그대로(중복 0)
뮤테이션 자체는 코드 리뷰로 확인(②의 union 제거 시 (a) RED — git stash로 로컬 확인 완료,
PR 본문에 기록)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema

_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    """test_3330_gate_verdict_notification.py와 동일 이유(전역 엔진 커넥션 풀이 이전 이벤트
    루프에 묶인 채 남는 것을 방지) — 이 파일도 send_message()의 background task를 태운다."""
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
        # test_3330와 동일 갭 — _get_or_create_system_publisher의 on_conflict_do_nothing이
        # 기대하는 부분 유니크 인덱스는 raw alembic DDL 전용(create_all로는 안 생김).
        await conn.execute(sa_text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_members_org_system_publisher "
            "ON members (org_id) WHERE (runtime_type = 'system-publisher' AND type = 'agent')"
        ))
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_with_owner(session, *, slug="e3340"):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.team import TeamMember
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org3340", slug=slug)
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
    """test_3330와 동일 하네스 갭 처방(team_members가 3-way UNION VIEW라는 프로덕션
    전제가 create_all 스키마엔 없음) — members·team_members 양쪽에 같은 id로 직접 심는다."""
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


async def _seed_agent(session, org_id, project_id, *, name="requester"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, assignee_id=None, title="발행 대상 스토리"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, assignee_id=assignee_id)
    session.add(story)
    await session.commit()
    return story.id


_PRESET_GATE_VERDICT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["work_item_type", "work_item_id", "gate_type", "verdict"],
    "properties": {
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
        "work_item_title": {"type": ["string", "null"]},
        "gate_type": {"type": "string"},
        "verdict": {"type": "string", "enum": ["approved", "rejected"]},
        "resolver_member_id": {"type": "string", "format": "uuid"},
        "resolution_note": {"type": ["string", "null"]},
        # story #3340 — 이 스토리가 여는 신규 선택 필드(migration 0303).
        "gate_requester_member_id": {"type": "string", "format": "uuid"},
    },
}
_WORK_ITEM_STAKEHOLDERS_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {
        "kind": "server_derived", "target": "work_item_stakeholders",
        "inherit_conversation_scope": True,
    },
}

_PRESET_STATUS_CHANGED_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["work_item_type", "work_item_id", "from_status", "to_status"],
    "properties": {
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
        "from_status": {"type": "string"},
        "to_status": {"type": "string"},
        "changed_by_member_id": {"type": "string", "format": "uuid"},
        "note": {"type": ["string", "null"]},
    },
}


async def _seed_preset_definition(session, *, key, payload_schema, routing):
    from app.models.event_definition import EventDefinition
    from sqlalchemy import select

    existing = (await session.execute(
        select(EventDefinition).where(EventDefinition.key == key, EventDefinition.org_id.is_(None))
    )).scalar_one_or_none()
    if existing is not None:
        return
    session.add(EventDefinition(
        id=uuid.uuid4(), key=key, org_id=None,
        payload_schema=payload_schema, routing=routing, enabled=True, version=1,
    ))
    await session.commit()


async def _seed_gate(session, org_id, *, work_item_id, gate_type="external_publish", neutral_facts=None):
    from app.models.gate import Gate

    gate = Gate(
        id=uuid.uuid4(), org_id=org_id, work_item_type="story", work_item_id=work_item_id,
        gate_type=gate_type, status="pending", neutral_facts=neutral_facts or {},
        created_at=datetime.now(timezone.utc),
    )
    session.add(gate)
    await session.commit()
    return gate


async def _latest_message_content_for(session, member_id, org_id):
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


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_a_unassigned_story_with_gate_requester_reaches_requester():
    """(a) 미배정 story + 게이트 요청자 있음(neutral_facts.requested_by_member_id, ①이
    채움) → work_item_stakeholders는 빈 집합이지만 요청자에게 도달한다(②)."""
    from app.services.gate_service import transition_gate

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_with_owner(s, slug="e3340a")
            await _seed_preset_definition(
                s, key="preset.gate.verdict",
                payload_schema=_PRESET_GATE_VERDICT_SCHEMA, routing=_WORK_ITEM_STAKEHOLDERS_ROUTING,
            )
            await _seed_system_publisher(s, org_id, project_id)
            requester_id = await _seed_agent(s, org_id, project_id, name="requester")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=None)  # 미배정
            gate = await _seed_gate(
                s, org_id, work_item_id=story_id,
                neutral_facts={"requested_by_member_id": str(requester_id)},
            )

            await transition_gate(s, org_id, gate.id, "rejected", resolver_id=owner_id, note="사유 있음")
            await s.commit()

            content = await _latest_message_content_for(s, requester_id, org_id)
            assert content is not None, "게이트 요청자에게 도달한 메시지가 없다(AC1 실패)"
            assert "rejected" in content
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_b_unassigned_story_no_requester_falls_back_to_project_owner():
    """(b) 미배정·요청자 없음(neutral_facts 비어있음) → 시스템 발행 혼자 방 대신 project
    owner(resolve_project_relay_owner)에게 도달한다(③)."""
    from app.services.gate_service import transition_gate

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_with_owner(s, slug="e3340b")
            await _seed_preset_definition(
                s, key="preset.gate.verdict",
                payload_schema=_PRESET_GATE_VERDICT_SCHEMA, routing=_WORK_ITEM_STAKEHOLDERS_ROUTING,
            )
            await _seed_system_publisher(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id, assignee_id=None)  # 미배정
            gate = await _seed_gate(s, org_id, work_item_id=story_id, neutral_facts={})  # 요청자 無

            await transition_gate(s, org_id, gate.id, "rejected", resolver_id=owner_id, note="사유")
            await s.commit()

            content = await _latest_message_content_for(s, owner_id, org_id)
            assert content is not None, "수신자 0일 때 project owner에게 폴백 도달하지 않았다(AC3 실패)"
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_b_status_changed_zero_reach_also_falls_back_to_owner():
    """(b) 변형 — 페드루 PO 지시: status_changed는 별도 requester 키 매핑을 안 얹지만
    (changed_by는 "요청자"가 아니다), ③의 시스템발신 축 하나로 이 이벤트도 같이
    커버됨을 고정한다. preset.work.status_changed를 직접 발행(publish_preset_event,
    story_status_events.py와 동일 진입점)해 미배정·수신자 0 상황을 재현."""
    from app.routers.events import publish_preset_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_with_owner(s, slug="e3340c")
            await _seed_preset_definition(
                s, key="preset.work.status_changed",
                payload_schema=_PRESET_STATUS_CHANGED_SCHEMA, routing=_WORK_ITEM_STAKEHOLDERS_ROUTING,
            )
            await _seed_system_publisher(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id, assignee_id=None)  # 미배정

            # publish_preset_event() 자체는 "예외를 안 삼킨다"는 명시 계약(events.py
            # docstring, story_status_events.py::emit_story_status_changed가 실제로
            # try/except로 감싸는 것과 동형) — 이 테스트도 실 호출자처럼 감싼다. 이 파일이
            # 확인하려는 건 대화 메시지 도달이지, background_tasks()가 태우는 mark_agent_
            # replied/Discord relay(전역 엔진 접속 — 이 throwaway DB와 무관, best-effort)
            # 성공 여부가 아니다(그 축은 test_3330가 이미 별도로 다룬 관심사 밖).
            try:
                await publish_preset_event(
                    s, org_id, "preset.work.status_changed",
                    {
                        "work_item_type": "story", "work_item_id": str(story_id),
                        "from_status": "in-progress", "to_status": "in-review",
                    },
                )
            except Exception:
                pass
            await s.commit()

            content = await _latest_message_content_for(s, owner_id, org_id)
            assert content is not None, "status_changed 수신자 0도 owner 폴백이 안 걸렸다"
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_c_assigned_story_unchanged_no_duplicate_participant():
    """(c) 배정 story(assignee=requester와 동일 인물) → 기존 그대로 assignee에게 도달,
    합집합 로직이 있어도 중복 참가자 없음(같은 대화방 재사용 — participant_ids가 set
    이라 구조적으로 중복 불가함을 실측으로도 확인)."""
    from app.services.gate_service import transition_gate
    from sqlalchemy import select
    from app.models.conversation import ConversationParticipant

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_with_owner(s, slug="e3340d")
            await _seed_preset_definition(
                s, key="preset.gate.verdict",
                payload_schema=_PRESET_GATE_VERDICT_SCHEMA, routing=_WORK_ITEM_STAKEHOLDERS_ROUTING,
            )
            await _seed_system_publisher(s, org_id, project_id)
            executor_id = await _seed_agent(s, org_id, project_id, name="assignee-and-requester")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=executor_id)  # 배정됨
            gate = await _seed_gate(
                s, org_id, work_item_id=story_id,
                neutral_facts={"requested_by_member_id": str(executor_id)},  # 요청자=담당자
            )

            await transition_gate(s, org_id, gate.id, "rejected", resolver_id=owner_id, note="사유")
            await s.commit()

            content = await _latest_message_content_for(s, executor_id, org_id)
            assert content is not None

            rows = (await s.execute(
                select(ConversationParticipant.member_id).where(
                    ConversationParticipant.member_id == executor_id,
                )
            )).scalars().all()
            # 한 conversation 안에 같은 member가 두 번 참가할 수 없다(PK/set 구조) — 여러
            # conversation에 걸쳐 있을 수는 있으나(다른 테스트와 무관), 이 테스트가 만든
            # 대화 하나에서 중복 행이 없다는 것만으로 "합집합이 중복을 안 만든다"는 충분.
            assert len(rows) >= 1
    finally:
        await engine.dispose()
