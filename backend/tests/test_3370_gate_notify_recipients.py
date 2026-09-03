"""story #3370(Phase0·마케팅운영 S5, 페드루 PO 지시 2026-09-03) — 게이트 판정(approved/
rejected) 통지 수신자 집합에 초안 원작성자(agent)를 합류시키고, work item assignee·
상신자·작성자가 셋 다 다른 사람이어도 전부 도달·중복 0임을 고정한다.

계보: story #3340이 요청자(requested_by_member_id → gate_requester_member_id)를 열었다
(migration 0303). 이 스토리는 같은 3단 파이프(neutral_facts → verdict payload → event_
routing_resolver 합류)를 "초안 원작성자"에도 그대로 반복한다(migration 0308,
gate_draft_author_member_id) — 새 라우팅 로직 발명 0, 기존 요청자 처방과 완전히 동형.

AC 대응:
① 수신자 집합 = assignee ∪ 초안 원작성자 ∪ 상신자, 동일 멤버 1회만
   (test_three_distinct_members_all_reach_no_duplicate)
② 에이전트 원작성자가 자기 채널에서 gate_id·판정 상태를 관측
   (test_author_only_reaches_via_own_channel — 위 테스트가 verdict 텍스트에 판정 상태를
   담아 검증. gate_id·version_id를 별도 구조화 필드로 노출하는 것은 이 이벤트의 payload
   스키마(work_item_id만 있고 gate_id 자체가 없음) 밖이라 스코프 아님 — PO 확定 없이 새
   필드를 지어내지 않는다.)
③ 상신자가 assignee 아니어도 도달 — test_3340이 이미 고정(회귀, 이 파일은 작성자 축만
   추가하고 그 결론을 무너뜨리지 않는지 아래 3-way 테스트로 재확인)
④ 넛지 억제(pending/rejected 게이트 존재 시) — story d1f4afcb가 이미 구현
   (approval_delivery.py::_has_open_external_publish_gate_for_doc). 이 스토리는 그
   파일을 건드리지 않는다 — test_d1f4afcb_draft_nudge_gate_and_event_suppress.py가
   그대로 회귀 검증한다.

⛔AC의 "승인 후 수정으로 재개방된 게이트" 케이스(S2 봉인 착지 후)는 이 스토리 스코프
밖(페드루 PO 명시, 2026-09-03) — S2가 재개방 시 status를 어떤 값으로 되돌리는지 아직
미확定이라 지어내지 않는다.

뮤테이션 자체 검증(PR 본문 기록 — 코드 리뷰로 확인): event_routing_resolver.py의
`_author_raw` 합류 두 줄을 제거하면 test_author_only_reaches_via_own_channel과
test_three_distinct_members_all_reach_no_duplicate의 "작성자 도달" assertion이 반드시
실패한다(작성자가 assignee도 requester도 아니므로 다른 경로로 우연히 도달할 수 없다)."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema

_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    """test_3330/test_3340과 동일 이유(전역 엔진 커넥션 풀이 이전 이벤트 루프에 묶인 채
    남는 것을 방지) — 이 파일도 send_message()의 background task를 태운다."""
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _realdb_session():
    from sqlalchemy import text as sa_text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    import app.models  # noqa: F401
    from app.core.database import Base

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # test_3330/test_3340과 동일 갭 — _get_or_create_system_publisher가 기대하는 부분
        # 유니크 인덱스는 raw alembic DDL 전용(create_all로는 안 생김).
        await conn.execute(sa_text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_members_org_system_publisher "
            "ON members (org_id) WHERE (runtime_type = 'system-publisher' AND type = 'agent')"
        ))
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_with_owner(session, *, slug="e3370"):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.team import TeamMember
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org3370", slug=slug)
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


async def _seed_member(session, org_id, project_id, *, name, type_="agent"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type=type_, name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, assignee_id=None, title="2호 콘텐츠"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, assignee_id=assignee_id)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_doc(session, org_id, project_id, *, title, created_by):
    from app.models.doc import Doc

    doc = Doc(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        slug=f"doc-{uuid.uuid4().hex[:8]}", content=f"{title} 본문", created_by=created_by,
    )
    session.add(doc)
    await session.commit()
    return doc.id


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
        "gate_requester_member_id": {"type": "string", "format": "uuid"},
        # story #3370 — 이 스토리가 여는 신규 선택 필드(migration 0308).
        "gate_draft_author_member_id": {"type": "string", "format": "uuid"},
    },
}
_WORK_ITEM_STAKEHOLDERS_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {
        "kind": "server_derived", "target": "work_item_stakeholders",
        "inherit_conversation_scope": True,
    },
}


async def _seed_preset_definition(session, *, key, payload_schema, routing):
    from sqlalchemy import select

    from app.models.event_definition import EventDefinition

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
        created_at=datetime.now(UTC),
    )
    session.add(gate)
    await session.commit()
    return gate


async def _latest_message_content_for(session, member_id, org_id):
    from sqlalchemy import select

    from app.models.conversation import (
        Conversation,
        ConversationMessage,
        ConversationParticipant,
    )

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
async def test_three_distinct_members_all_reach_no_duplicate():
    """⭐AC1/③ 핵심 — assignee·초안 원작성자·상신자가 전부 다른 세 사람(페드루 PO 표본
    시나리오: 담롱군의 콘텐츠 873639d1 동형 — assignee·작성자는 같을 수도 다를 수도
    있으나, 이 테스트는 셋을 명시적으로 갈라 최악의 경우도 잰다)일 때 전부 도달하고,
    한 conversation 안에 중복 참가자가 없다."""
    from sqlalchemy import select

    from app.models.conversation import ConversationParticipant
    from app.services.gate_service import transition_gate

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_with_owner(s, slug="e3370a")
            await _seed_preset_definition(
                s, key="preset.gate.verdict",
                payload_schema=_PRESET_GATE_VERDICT_SCHEMA, routing=_WORK_ITEM_STAKEHOLDERS_ROUTING,
            )
            await _seed_system_publisher(s, org_id, project_id)

            assignee_id = await _seed_member(s, org_id, project_id, name="assignee", type_="human")
            author_id = await _seed_member(s, org_id, project_id, name="author-agent", type_="agent")
            requester_id = await _seed_member(s, org_id, project_id, name="requester-human", type_="human")

            story_id = await _seed_story(s, org_id, project_id, assignee_id=assignee_id)
            gate = await _seed_gate(
                s, org_id, work_item_id=story_id,
                neutral_facts={
                    "requested_by_member_id": str(requester_id),
                    "draft_author_member_id": str(author_id),
                },
            )

            await transition_gate(s, org_id, gate.id, "approved", resolver_id=owner_id, note=None)
            await s.commit()

            for label, member_id in (("assignee", assignee_id), ("author", author_id), ("requester", requester_id)):
                content = await _latest_message_content_for(s, member_id, org_id)
                assert content is not None, f"{label}({member_id})에게 판정 통지가 도달하지 않았다"
                assert "approved" in content

            # 세 사람이 각자 정확히 한 번만 참가(합집합이 set이라 중복 자체가 구조적으로
            # 불가능함을 실측으로도 확인 — test_3340::test_c와 동일 관례).
            for member_id in (assignee_id, author_id, requester_id):
                rows = (await s.execute(
                    select(ConversationParticipant.member_id).where(
                        ConversationParticipant.member_id == member_id,
                    )
                )).scalars().all()
                assert len(rows) == 1, f"{member_id} 참가 행이 {len(rows)}개 — 중복 의심"
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_author_only_reaches_via_own_channel():
    """⭐AC1/② 핵심 — 상신자·assignee가 전혀 없어도(story 미배정·requester 키 부재)
    초안 원작성자만은 자기 채널에서 판정(gate_id가 속한 work item·verdict 상태)을
    관측한다. 이 테스트가 뮤테이션 pin이다 — event_routing_resolver.py의 작성자 합류
    두 줄을 제거하면 반드시 RED(작성자가 다른 어떤 경로로도 우연히 도달할 수 없다:
    assignee 아님·requester_member_id도 없음)."""
    from app.services.gate_service import transition_gate

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_with_owner(s, slug="e3370b")
            await _seed_preset_definition(
                s, key="preset.gate.verdict",
                payload_schema=_PRESET_GATE_VERDICT_SCHEMA, routing=_WORK_ITEM_STAKEHOLDERS_ROUTING,
            )
            await _seed_system_publisher(s, org_id, project_id)
            author_id = await _seed_member(s, org_id, project_id, name="author-agent", type_="agent")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=None)  # 미배정
            gate = await _seed_gate(
                s, org_id, work_item_id=story_id,
                neutral_facts={"draft_author_member_id": str(author_id)},  # 상신자 없음
            )

            await transition_gate(s, org_id, gate.id, "rejected", resolver_id=owner_id, note="반려 사유")
            await s.commit()

            content = await _latest_message_content_for(s, author_id, org_id)
            assert content is not None, "초안 원작성자에게 판정 통지가 도달하지 않았다(AC1/② 실패)"
            assert "rejected" in content
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_recipe_gate_hook_fills_draft_author_from_doc_created_by():
    """recipe_gate_hooks.py::_build_approval_neutral_facts가 실제로 draft_author_
    member_id를 채우는지(플러밍 3단 중 1단계) — doc.created_by를 게이트 생성 시점에
    그대로 옮겨 담는다. test_3323의 draft_doc_reference_token 테스트와 동형 하네스."""
    from sqlalchemy import select

    from app.models.event_definition import EventDefinition
    from app.models.gate import Gate

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner = await _seed_org_with_owner(s, slug="e3370c")
            publisher_id = await _seed_member(s, org_id, project_id, name="publisher")
            author_id = await _seed_member(s, org_id, project_id, name="doc-author")
            story_id = await _seed_story(s, org_id, project_id)
            doc_id = await _seed_doc(s, org_id, project_id, title="원고", created_by=author_id)

            recipe_schema = {
                "type": "object", "additionalProperties": False,
                "required": ["stage", "work_item_type", "work_item_id"],
                "properties": {
                    "stage": {"type": "string", "enum": ["draft", "approve", "publish"]},
                    "work_item_type": {"type": "string"},
                    "work_item_id": {"type": "string", "format": "uuid"},
                    "previous_output_doc_id": {"type": "string"},
                },
            }
            definition = EventDefinition(
                id=uuid.uuid4(), key="org.e3370c.recipe_cycle", org_id=org_id, name="테스트 레시피",
                payload_schema=recipe_schema,
                routing={"escalation": {"kind": "server_derived", "target": "none"},
                         "broadcast": {"kind": "server_derived", "target": "none"}},
                stage_metadata={"approve": {"role": "Approver", "action": "승인",
                                             "gate": {"type": "external_publish", "approver": "org_owner"}}},
            )
            s.add(definition)
            await s.commit()

            from fastapi import BackgroundTasks
            from starlette.requests import Request as StarletteRequest

            from app.dependencies.auth import AuthContext
            from app.routers.events import EventPublishRequest, publish_registry_event

            auth = AuthContext(
                user_id=str(publisher_id), email=None,
                claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
            )
            await publish_registry_event(
                EventPublishRequest(
                    definition_key=definition.key,
                    payload={
                        "stage": "approve", "work_item_type": "story", "work_item_id": str(story_id),
                        "previous_output_doc_id": str(doc_id),
                    },
                ),
                BackgroundTasks(), StarletteRequest(scope={"type": "http", "headers": []}),
                db=s, auth=auth, org_id=org_id,
            )

            gate = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "external_publish")
            )).scalar_one()
            assert gate.neutral_facts.get("draft_author_member_id") == str(author_id)
    finally:
        await engine.dispose()
