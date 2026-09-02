"""story #3325(4a016f5a)/#3326(0e3abfaf) — PR C. PO 확定(페드루, 2026-09-02):

①recipe_gate_hooks.maybe_create_stage_gate가 create_gate() 뒤 채팅 결재 카드까지 이어
보낸다(결재함 탭에만 서고 채팅 알림 0이던 결함 — #4a016f5a).
②기존 게이트 status별 처리(#0e3abfaf 재프레임) — rejected는 `_reopen_rejected_gate`
재사용으로 pending 복귀+카드 재발송, voided는 admin 판단 유지(#04e69c5f/#2150 AC5,
자동 재오픈 대상 아님)로 0건+명시 로그, pending은 멱등(카드 재발송 없음).

범용 create_gate()/_reopen_rejected_gate()는 무변경 — 전부 recipe_gate_hooks.py의
호출부(caller) 쪽에서만 처리한다(PO 지시, 최소 blast radius)."""
from __future__ import annotations

import datetime as dt
import logging
import uuid

import pytest
from fastapi import BackgroundTasks

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema

_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    """story a05da51b — 이 파일은 publish_registry_event/publish_preset_event/
    transition_gate/send_message 중 하나를 호출해 실제로 메시지를 발행하거나 게이트를
    전이시킨다 — `send_message`의 background task(`mark_agent_replied`)가 이 파일의
    throwaway 엔진이 아니라 `app.core.database.async_session_factory`(전역·프로세스
    수명 엔진)를 쓴다. destructive_schema 마커 파일이라 story #3330(PR#3711)이 conftest.py
    에 심은 전역 autouse(non-destructive 전용 스코프)의 적용 대상이 아니다 — 이 파일
    자신의 여러 테스트가 한 pytest 세션 안에서 순차 실행되며 같은 전역 엔진을 반복
    사용하므로, dispose 없이 두면 pytest-anyio의 테스트별 새 이벤트 루프 사이에서 커넥션
    누수/`Event loop is closed`로 이어질 수 있다(story #3330/PR#3711 실사고 — test_3330_
    gate_verdict_notification.py에서 최초 재현). 이 realdb 하네스의 표준 방어 fixture
    재사용(새 로직 0, story a05da51b — scripts/lint_destructive_publish_path_dispose_
    fixture.py 가드 대상)."""
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


async def _seed_org_with_owner(session, *, slug="acme3325"):
    """#3312의 동명 헬퍼와 달리, 승인자(owner)를 채팅 카드 수신자로도 쓰므로 TeamMember 행을
    같이 심는다 — ConversationParticipant.member_id는 team_members.id FK(NOT NULL)라, 카드
    dispatch(신규 축, ①)가 실제로 도달하려면 owner가 team_members에도 있어야 한다
    (test_3001_gate_delegate_realdb.py::_seed_org_member와 동일 이유)."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.team import TeamMember
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org3325", slug=slug)
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


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="레시피 산출물")
    session.add(story)
    await session.commit()
    return story.id


_CYCLE_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": ["draft", "approve", "publish"]},
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
        "channel": {"type": "string"},
    },
}
_CYCLE_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {"kind": "server_derived", "target": "none"},
}


async def _seed_recipe_definition(session, org_id, *, slug, stage_metadata):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=f"org.{slug}.recipe_cycle", org_id=org_id, name="테스트 레시피",
        payload_schema=_CYCLE_SCHEMA, routing=_CYCLE_ROUTING, stage_metadata=stage_metadata,
    )
    session.add(d)
    await session.commit()
    return d.key


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


def _fake_request() -> "StarletteRequest":
    from starlette.requests import Request as StarletteRequest
    return StarletteRequest(scope={"type": "http", "headers": []})


async def _publish_approve(session, org_id, publisher_id, definition_key, story_id):
    from app.routers.events import EventPublishRequest, publish_registry_event

    body = EventPublishRequest(
        definition_key=definition_key,
        payload={"stage": "approve", "work_item_type": "story", "work_item_id": str(story_id)},
    )
    await publish_registry_event(
        body, BackgroundTasks(), _fake_request(), db=session, auth=_auth(publisher_id, org_id), org_id=org_id,
    )


async def _card_messages_for_gate(session, gate_id, approver_id):
    from app.models.conversation import ConversationMessage
    from sqlalchemy import select

    return (await session.execute(
        select(ConversationMessage).where(
            ConversationMessage.msg_metadata["approval_target"]["gate_id"].astext == str(gate_id),
            ConversationMessage.mentioned_ids.contains([approver_id]),
        )
    )).scalars().all()


_STAGE_METADATA = {
    "approve": {
        "role": "Approver", "action": "승인",
        "gate": {"type": "external_publish", "approver": "org_owner"},
    },
}


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_fresh_pending_gate_dispatches_approval_card():
    """①⭐신규 pending 게이트가 생성되면 지정 승인자(org owner) DM에 카드 1건이 실제로
    선다(approval_target.gate_id=이 게이트, mentioned_ids에 owner 포함) — 결재함에만 서고
    채팅 알림 0이던 결함의 근본수정."""
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_with_owner(s, slug="acme3325a")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            definition_key = await _seed_recipe_definition(
                s, org_id, slug="acme3325a", stage_metadata=_STAGE_METADATA,
            )

            await _publish_approve(s, org_id, publisher_id, definition_key, story_id)

            gate = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "external_publish")
            )).scalar_one()
            assert gate.status == "pending"

            msgs = await _card_messages_for_gate(s, gate.id, owner_id)
            assert len(msgs) == 1, f"카드가 정확히 1건 서야 함 — {len(msgs)}건"
            assert msgs[0].msg_metadata["approval_target"]["designated"] is True
            assert msgs[0].msg_metadata["activation"]["kind"] == "request"
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_pending_gate_republish_is_idempotent_no_duplicate_card():
    """③이미 pending인 슬롯에 approve가 다시 발행돼도(재시도류) 게이트는 여전히 1건이고
    (기존 AC2), 카드도 반복 재발송되지 않는다(같은 승인 요청 스팸 방지, PO 확定)."""
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_with_owner(s, slug="acme3325b")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            definition_key = await _seed_recipe_definition(
                s, org_id, slug="acme3325b", stage_metadata=_STAGE_METADATA,
            )

            await _publish_approve(s, org_id, publisher_id, definition_key, story_id)
            await _publish_approve(s, org_id, publisher_id, definition_key, story_id)

            gates = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "external_publish")
            )).scalars().all()
            assert len(gates) == 1

            msgs = await _card_messages_for_gate(s, gates[0].id, owner_id)
            assert len(msgs) == 1, f"멱등 pending 재발행에서 카드가 중복 발송됨 — {len(msgs)}건"
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_rejected_gate_reopens_to_pending_and_resends_card_on_republish():
    """②-a 진짜 제품 경로 — rejected 게이트가 있는 work item에 approve가 재발행되면
    `_reopen_rejected_gate`(#04e69c5f 재제출 경로) 재사용으로 pending 복귀(신규 row
    0건 — 감사이력 보존) + 지정 승인자에게 카드가 새로 1건 더 선다(최초 카드 이후 두
    번째 카드, 합계 2건)."""
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_with_owner(s, slug="acme3325c")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            definition_key = await _seed_recipe_definition(
                s, org_id, slug="acme3325c", stage_metadata=_STAGE_METADATA,
            )

            await _publish_approve(s, org_id, publisher_id, definition_key, story_id)

            gate = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "external_publish")
            )).scalar_one()
            gate_id_before = gate.id
            gate.status = "rejected"
            gate.resolver_id = owner_id
            gate.resolved_at = dt.datetime.now(dt.timezone.utc)
            gate.resolution_note = "부적합"
            await s.commit()

            await _publish_approve(s, org_id, publisher_id, definition_key, story_id)

            gates = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "external_publish")
            )).scalars().all()
            assert len(gates) == 1, "신규 row가 생기면 안 됨(재오픈=같은 row 재사용)"
            assert gates[0].id == gate_id_before
            assert gates[0].status == "pending", "rejected → 재발행 시 pending으로 재오픈돼야"
            assert gates[0].resolver_id is None

            msgs = await _card_messages_for_gate(s, gates[0].id, owner_id)
            assert len(msgs) == 2, f"최초 카드+재오픈 카드=2건이어야 — {len(msgs)}건"
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_voided_gate_stays_voided_zero_new_gate_and_logs_explicitly(caplog):
    """②-b voided는 admin의 명시 무효화(#04e69c5f/#2150 AC5) — 자동 재오픈 대상이 아니다.
    approve 재발행해도 새 게이트 0건(회귀 없음, 기존 voided row 그대로)·카드도 0건, 대신
    "왜 안 갔는지"가 침묵이 아니라 명시 로그로 관측 가능해야 한다."""
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_with_owner(s, slug="acme3325d")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            definition_key = await _seed_recipe_definition(
                s, org_id, slug="acme3325d", stage_metadata=_STAGE_METADATA,
            )

            # admin이 직접 void한 게이트를 재현(hook을 거치지 않고 미리 심는다 — void_gate_
            # endpoint 자체는 story #S30 범위, 여기선 그 사후 상태만 재현).
            voided_gate = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, work_item_type="story",
                gate_type="external_publish", status="voided", designated_approver_id=owner_id,
                resolver_id=owner_id, resolved_at=dt.datetime.now(dt.timezone.utc),
                resolution_note="admin_void: 좀비 방지",
            )
            s.add(voided_gate)
            await s.commit()
            voided_gate_id = voided_gate.id

            with caplog.at_level(logging.INFO, logger="app.services.recipe_gate_hooks"):
                await _publish_approve(s, org_id, publisher_id, definition_key, story_id)

            gates = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "external_publish")
            )).scalars().all()
            assert len(gates) == 1, f"voided에서 새 게이트가 생기면 안 됨 — {len(gates)}건"
            assert gates[0].id == voided_gate_id
            assert gates[0].status == "voided"

            msgs = await _card_messages_for_gate(s, voided_gate_id, owner_id)
            assert msgs == [], "voided 상태에서 카드가 새면 안 됨"

            assert any(
                "voided" in rec.message and str(voided_gate_id) in rec.message
                for rec in caplog.records
            ), "voided no-op이 명시 로그로 관측 가능해야 함(완전 침묵 금지)"
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_card_dispatch_failure_does_not_roll_back_gate_creation():
    """카드 배달은 best-effort — dispatch_approval_request_cards가 실패해도 게이트
    생성/재오픈 자체는 되돌아가지 않는다(create_gate()의 gate.pending_approval 알림과
    동일 관례, monkeypatch로 강제 실패 재현)."""
    from app.models.gate import Gate
    from sqlalchemy import select
    import app.services.recipe_gate_hooks as hooks_module

    async def _boom(*_a, **_kw):
        raise RuntimeError("card delivery boom")

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_with_owner(s, slug="acme3325e")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            definition_key = await _seed_recipe_definition(
                s, org_id, slug="acme3325e", stage_metadata=_STAGE_METADATA,
            )

            import app.services.approval_delivery as approval_delivery_module
            original = approval_delivery_module.dispatch_approval_request_cards
            approval_delivery_module.dispatch_approval_request_cards = _boom
            try:
                await _publish_approve(s, org_id, publisher_id, definition_key, story_id)
            finally:
                approval_delivery_module.dispatch_approval_request_cards = original

            gate = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "external_publish")
            )).scalar_one()
            assert gate.status == "pending", "카드 배달 실패가 게이트 생성 자체를 되돌리면 안 됨"
    finally:
        await engine.dispose()
