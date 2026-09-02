"""story #3330(2419cbf9) — 게이트 approved/rejected 전이가 실행자(work item assignee)에게
실제로 도달하는지 검증.

근본원인(소스 확認, 추측 0): `preset.gate.verdict` 발행이 예전엔
`gate_service._record_gate_review_verdict`(H1-S7, verdict-capture용) 안에 있어
`_GATE_TYPE_TO_VERDICT_SOURCE`(qa/deploy/merge/pr_review 4종뿐)에 없는 gate_type
(예: external_publish — 이 스토리의 실제 사고)은 통지가 아예 발행되지 않았다. 이 정정은
`_publish_gate_verdict_notification`을 그 게이팅과 독립적으로 `transition_gate`에서
직접 호출한다.

AC1 — rejected 전이 시 work item assignee에게 실제로 채팅 메시지 도달(실 HTTP 왕복).
AC2 — 그 메시지에 반려 사유·산출물 doc 클릭 토큰·다음 행동이 실린다.
AC3 — approved 전이도 같은 대상에게 도달(대칭).
AC5 — 뮤테이션: 발행 훅을 지우면 AC1 RED."""
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
    """이 파일의 테스트는 실제로 메시지를 발행해 `send_message`의 background task
    (`mark_agent_replied`)를 태운다 — 그 task는 이 테스트가 만든 throwaway 엔진이 아니라
    `app.core.database.async_session_factory`(전역, 프로세스 수명 엔진)를 쓴다. pytest-anyio는
    테스트 함수마다 새 이벤트 루프를 만드는데, 이 전역 엔진의 커넥션 풀을 dispose 없이 그대로
    두면 다음 테스트(새 루프)가 그 풀에서 "이전 루프에 묶인" 커넥션을 재사용하려다
    `Connection._cancel` 미await 경고·`Event loop is closed`로 이어진다(실측 확인 — 이 파일의
    테스트 2개를 한 세션에서 돌리면 재현). 이 프로젝트 realdb 테스트 246개가 이미 쓰는
    표준 방어 fixture(예: test_e_mcp_opt_ff6cb90d_multiproject_scoping_realdb.py)를
    동일하게 적용 — 이 파일에 빠져 있던 것이 결함이었다."""
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
        # migration 0258_system_publisher_member.py — `_get_or_create_system_publisher`
        # (events.py, publish_preset_event이 매번 부른다)의 on_conflict_do_nothing이
        # 기대하는 부분 유니크 인덱스는 raw alembic DDL로만 존재하고 SQLAlchemy ORM
        # 모델(`Member`)엔 선언이 없어 `Base.metadata.create_all`로는 안 생긴다 — 실측
        # 확認(이 인덱스 없이 돌리면 "no unique or exclusion constraint matching the
        # ON CONFLICT specification"으로 즉시 실패, postgres 서버 로그로 확인). 이
        # 스토리와 무관한 기존 realdb 테스트 하네스 갭이라 여기서 직접 재현해 채운다.
        await conn.execute(sa_text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_members_org_system_publisher "
            "ON members (org_id) WHERE (runtime_type = 'system-publisher' AND type = 'agent')"
        ))
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_with_owner(session, *, slug="e3330"):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.team import TeamMember
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org3330", slug=slug)
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
    """`publish_preset_event`가 매번 부르는 `_get_or_create_system_publisher`(events.py,
    story #2791)는 프로덕션에서 `team_members`가 `members`/`project_access` 위 3-way
    UNION VIEW라는 전제(migration 0088+/0110/0258)로 "members에 넣으면 team_members
    조회에서도 보인다"를 가정한다. `Base.metadata.create_all`로 만든 이 테스트 스키마는
    `team_members`가 (다른 realdb 테스트들도 그렇듯) 독립된 ORM 테이블이라 그 뷰 동기화가
    없다 — `members`에 넣어도 `team_members`(=`resolve_member`가 실제로 읽는 곳)엔 안
    보여 "Team member not found"로 즉시 실패한다(실측 확인). 이 스토리와 무관한 기존
    하네스 갭이라, 뷰가 만들었을 결과를 여기서 직접 흉내내 두 테이블에 같은 id로 미리
    심어둔다 — `_get_or_create_system_publisher`는 `members`에서 기존 행을 찾으면 그대로
    반환하고 새로 안 만든다."""
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


async def _seed_story(session, org_id, project_id, *, assignee_id, title="발행 대상 스토리"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, assignee_id=assignee_id)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_doc(session, org_id, project_id, *, title):
    from app.models.doc import Doc

    doc = Doc(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        slug=f"doc-{uuid.uuid4().hex[:8]}", content=f"{title} 본문",
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
        "gate_type": {"type": "string"},
        "verdict": {"type": "string", "enum": ["approved", "rejected"]},
        "resolver_member_id": {"type": "string", "format": "uuid"},
        "resolution_note": {"type": ["string", "null"]},
    },
}
_PRESET_GATE_VERDICT_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {
        "kind": "server_derived", "target": "work_item_stakeholders",
        "inherit_conversation_scope": True,
    },
}


async def _seed_preset_gate_verdict_definition(session):
    """realdb 테스트 DB는 `Base.metadata.create_all`로 스키마만 얻고 alembic 시드
    마이그레이션(0245_event_definitions.py)은 안 타므로, 그 마이그레이션이 심는
    `preset.gate.verdict` 프리셋 정의(payload_schema/routing 동일 값, org_id=None=
    전역 프리셋)를 직접 재현해 심는다 — 이게 없으면 `publish_preset_event`가 "정의
    없음"으로 조용히 no-op한다(그 자체는 정상 동작이지만, 이 테스트 목적엔 실 프리셋
    존재를 전제해야 한다)."""
    from app.models.event_definition import EventDefinition
    from sqlalchemy import select

    existing = (await session.execute(
        select(EventDefinition).where(
            EventDefinition.key == "preset.gate.verdict", EventDefinition.org_id.is_(None),
        )
    )).scalar_one_or_none()
    if existing is not None:
        return
    session.add(EventDefinition(
        id=uuid.uuid4(), key="preset.gate.verdict", org_id=None,
        payload_schema=_PRESET_GATE_VERDICT_SCHEMA, routing=_PRESET_GATE_VERDICT_ROUTING,
        enabled=True, version=1,
    ))
    await session.commit()


async def _seed_gate(
    session, org_id, *, work_item_id, gate_type="external_publish", work_item_type="story", neutral_facts=None,
):
    from app.models.gate import Gate

    gate = Gate(
        id=uuid.uuid4(), org_id=org_id, work_item_type=work_item_type, work_item_id=work_item_id,
        gate_type=gate_type, status="pending", neutral_facts=neutral_facts or {},
        created_at=datetime.now(timezone.utc),
    )
    session.add(gate)
    await session.commit()
    return gate


async def _latest_message_content_for(session, agent_id, org_id):
    """agent_id가 참가자인 conversation들 중 가장 최근 메시지 하나를 가져온다(도달 확認용)."""
    from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant
    from sqlalchemy import select

    row = (await session.execute(
        select(ConversationMessage)
        .join(ConversationParticipant, ConversationParticipant.conversation_id == ConversationMessage.conversation_id)
        .join(Conversation, Conversation.id == ConversationMessage.conversation_id)
        .where(ConversationParticipant.member_id == agent_id, Conversation.org_id == org_id)
        .order_by(ConversationMessage.created_at.desc())
        .limit(1)
    )).scalar_one_or_none()
    return row.content if row is not None else None


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_rejected_gate_reaches_work_item_assignee_with_reason_and_next_action():
    """⭐AC1/AC2 핵심 — 실사례 재현: gate_type=external_publish(verdict-capture 매핑에
    없는 타입)가 rejected로 전이되면, work item assignee에게 반려 사유+다음 행동이
    실린 메시지가 실제로 도달한다."""
    from app.services.gate_service import transition_gate

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_with_owner(s, slug="e3330a")
            await _seed_preset_gate_verdict_definition(s)
            await _seed_system_publisher(s, org_id, project_id)
            executor_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id, assignee_id=executor_id)
            doc_id = await _seed_doc(s, org_id, project_id, title="Threads 포스트 초안 v1")
            gate = await _seed_gate(
                s, org_id, work_item_id=story_id,
                neutral_facts={"draft_doc_reference_token": f"[Threads 포스트 초안 v1](entity:doc:{doc_id})"},
            )

            await transition_gate(
                s, org_id, gate.id, "rejected", resolver_id=owner_id, note="어투가 너무 딱딱함 — 다시",
            )
            await s.commit()

            content = await _latest_message_content_for(s, executor_id, org_id)
            assert content is not None, "executor에게 도달한 메시지가 없다(AC1 실패)"
            assert "- 게이트: external_publish → rejected" in content
            assert "- 반려 사유: 어투가 너무 딱딱함 — 다시" in content
            assert f"[Threads 포스트 초안 v1](entity:doc:{doc_id})" in content
            assert "approve stage 이벤트를 다시 발행하세요" in content
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_approved_gate_also_reaches_work_item_assignee():
    """⭐AC3 — 승인 방향도 동일 대상에게 도달(대칭)."""
    from app.services.gate_service import transition_gate

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_with_owner(s, slug="e3330b")
            await _seed_preset_gate_verdict_definition(s)
            await _seed_system_publisher(s, org_id, project_id)
            executor_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id, assignee_id=executor_id)
            gate = await _seed_gate(s, org_id, work_item_id=story_id)

            await transition_gate(s, org_id, gate.id, "approved", resolver_id=owner_id)
            await s.commit()

            content = await _latest_message_content_for(s, executor_id, org_id)
            assert content is not None
            assert "- 게이트: external_publish → approved" in content
            assert "다음 stage 이벤트를 발행하세요" in content
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_gate_type_outside_verdict_capture_mapping_still_notifies():
    """⭐근본원인 직접 재현 — gate_type이 `_GATE_TYPE_TO_VERDICT_SOURCE`(qa/deploy/merge/
    pr_review)에 전혀 없어도(이 테스트는 완전히 임의의 커스텀 타입으로 한 번 더 확인)
    통지는 발행된다 — verdict-capture 게이팅과 통지가 이제 독립임을 pin."""
    from app.services.gate_service import _GATE_TYPE_TO_VERDICT_SOURCE, transition_gate

    assert "totally_custom_gate_type" not in _GATE_TYPE_TO_VERDICT_SOURCE  # 전제 확인

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_with_owner(s, slug="e3330c")
            await _seed_preset_gate_verdict_definition(s)
            await _seed_system_publisher(s, org_id, project_id)
            executor_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id, assignee_id=executor_id)
            gate = await _seed_gate(s, org_id, work_item_id=story_id, gate_type="totally_custom_gate_type")

            await transition_gate(s, org_id, gate.id, "rejected", resolver_id=owner_id, note="사유")
            await s.commit()

            content = await _latest_message_content_for(s, executor_id, org_id)
            assert content is not None
            assert "totally_custom_gate_type → rejected" in content
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_system_auto_transition_without_resolver_does_not_notify():
    """경계 — resolver_id 없는 전이(시스템 auto-transition)는 통지하지 않는다(사람이
    판정한 게 아니므로 "사람이 판정했다" 통지 대상이 아님 — 기존 가드와 동일 취지)."""
    from app.services.gate_service import transition_gate

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner_id = await _seed_org_with_owner(s, slug="e3330d")
            await _seed_preset_gate_verdict_definition(s)
            await _seed_system_publisher(s, org_id, project_id)
            executor_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id, assignee_id=executor_id)
            gate = await _seed_gate(s, org_id, work_item_id=story_id)

            await transition_gate(s, org_id, gate.id, "approved", resolver_id=None)
            await s.commit()

            content = await _latest_message_content_for(s, executor_id, org_id)
            assert content is None
    finally:
        await engine.dispose()
