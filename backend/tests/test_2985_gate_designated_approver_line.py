"""story #2985(PO 설계 확定 2026-08-24) — 결재선(수신자) 개념. 핵심 검증축:
①dispatch_approval_request_cards가 designated_approver_id 지정 시 그 1인만 kind="request"
(액션)·나머지는 kind="request_info"(정보성)로 갈리는지 ②미지정(None)이면 전원 "request"
그대로(회귀 0) ③designated_approver_id가 approver_ids 밖이면 fail-safe로 미지정 취급
④create_gate()가 신규+rejected재오픈 경로 둘 다에서 designated_approver_id를 저장하는지
⑤notify_gate_card_recipients_resolved가 "실제 카드 심어진" 모든 conversation(액션+정보성
무관)에 conversation.gate_resolved Event를 심는지, 카드가 없으면 no-op인지. 로컬 PG 미설정
시 skip(CI 관례 동일)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


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


async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2985", slug=f"org2985-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_human(session, org_id, project_id, *, name="member"):
    from app.models.team import TeamMember

    m = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="human",
        name=name, is_active=True,
    )
    session.add(m)
    await session.commit()
    return m.id


async def _seed_doc(session, org_id, project_id, *, title="설계 문서"):
    from app.models.doc import Doc

    doc = Doc(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        content="본문", status="pending", slug=f"doc-{uuid.uuid4().hex[:8]}",
    )
    session.add(doc)
    await session.commit()
    return doc


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_dispatch_splits_designated_action_vs_others_informational():
    from app.services.approval_delivery import dispatch_approval_request_cards
    from app.models.conversation import ConversationMessage
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_human(s, org_id, project_id, name="requester")
            designated = await _seed_human(s, org_id, project_id, name="po")
            other = await _seed_human(s, org_id, project_id, name="teacher")
            doc = await _seed_doc(s, org_id, project_id)
            gate_id = uuid.uuid4()

            await dispatch_approval_request_cards(
                s, org_id=org_id, work_item_type="doc", work_item_id=doc.id,
                project_id=doc.project_id, title=doc.title, gate_id=gate_id,
                requester_id=requester_id, approver_ids=[designated, other],
                designated_approver_id=designated,
            )
            await s.commit()

            msgs = (await s.execute(select(ConversationMessage))).scalars().all()
            assert len(msgs) == 2
            by_recipient = {uuid.UUID(str(m.mentioned_ids[0])): m for m in msgs}

            designated_msg = by_recipient[designated]
            assert designated_msg.msg_metadata["activation"]["kind"] == "request"
            assert designated_msg.msg_metadata["activation"]["expects_response"] is True
            assert designated_msg.msg_metadata["approval_target"]["designated"] is True
            # 유나 FE 스펙(2026-08-24) — 정보성 카드의 "{이름}에게 요청된 결재" 안내문구용
            # 실명. 지정자 자신의 카드에도 같이 실리지만(단순화 — 별도 분기 없음) 안 읽힘.
            assert designated_msg.msg_metadata["approval_target"]["designated_approver_name"] == "po"

            other_msg = by_recipient[other]
            assert other_msg.msg_metadata["activation"]["kind"] == "request_info"
            assert other_msg.msg_metadata["activation"]["expects_response"] is False
            assert other_msg.msg_metadata["approval_target"]["designated"] is False
            assert other_msg.msg_metadata["approval_target"]["designated_approver_name"] == "po"
            # 정보성이어도 해소 권한 자체는 유지 — actions는 그대로.
            assert other_msg.msg_metadata["approval_target"]["actions"] == ["approve", "reject"]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_dispatch_no_designation_keeps_all_actionable_no_regression():
    from app.services.approval_delivery import dispatch_approval_request_cards
    from app.models.conversation import ConversationMessage
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_human(s, org_id, project_id, name="requester")
            a1 = await _seed_human(s, org_id, project_id, name="a1")
            a2 = await _seed_human(s, org_id, project_id, name="a2")
            doc = await _seed_doc(s, org_id, project_id)

            await dispatch_approval_request_cards(
                s, org_id=org_id, work_item_type="doc", work_item_id=doc.id,
                project_id=doc.project_id, title=doc.title, gate_id=uuid.uuid4(),
                requester_id=requester_id, approver_ids=[a1, a2],
                # designated_approver_id 생략 — 기본값 None.
            )
            await s.commit()

            msgs = (await s.execute(select(ConversationMessage))).scalars().all()
            assert len(msgs) == 2
            for m in msgs:
                assert m.msg_metadata["activation"]["kind"] == "request"
                assert m.msg_metadata["activation"]["expects_response"] is True
                assert m.msg_metadata["approval_target"]["designated"] is True
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_dispatch_designated_outside_approver_ids_falls_back_safely():
    """designated_approver_id가 approver_ids 밖(오탈자·이미 조직 이탈 등)이면 fail-safe로
    미지정 취급 — 지정자가 카드를 아예 못 받거나 권한 없는 사람이 액션을 받는 두 실패 모드를
    피한다(approval_delivery.py 가드)."""
    from app.services.approval_delivery import dispatch_approval_request_cards
    from app.models.conversation import ConversationMessage
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_human(s, org_id, project_id, name="requester")
            a1 = await _seed_human(s, org_id, project_id, name="a1")
            stray_id = uuid.uuid4()  # approver_ids 밖의 값(오탈자류 시뮬레이션).
            doc = await _seed_doc(s, org_id, project_id)

            await dispatch_approval_request_cards(
                s, org_id=org_id, work_item_type="doc", work_item_id=doc.id,
                project_id=doc.project_id, title=doc.title, gate_id=uuid.uuid4(),
                requester_id=requester_id, approver_ids=[a1],
                designated_approver_id=stray_id,
            )
            await s.commit()

            msgs = (await s.execute(select(ConversationMessage))).scalars().all()
            assert len(msgs) == 1
            assert msgs[0].msg_metadata["activation"]["kind"] == "request"  # 미지정 취급 → 액션 유지.
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_create_gate_persists_designated_approver_id():
    from app.services.gate_service import create_gate
    from sqlalchemy import select
    from app.models.gate import Gate

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_human(s, org_id, project_id, name="requester")
            designated = await _seed_human(s, org_id, project_id, name="po")
            work_item_id = uuid.uuid4()

            gate = await create_gate(
                s, org_id, work_item_id, "doc", "doc_approval",
                requester_id, uuid.uuid4(), project_id=project_id, notify=False,
                designated_approver_id=designated,
            )
            await s.commit()

            row = (await s.execute(select(Gate).where(Gate.id == gate.id))).scalar_one()
            assert row.designated_approver_id == designated
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_create_gate_reopen_restamps_designated_approver_id():
    """재제출(rejected→새 사이클)이 이번 상신의 결재선으로 재stamp한다 — 옛 사이클 지정을
    그대로 물려받지 않는다(doc.py requested_by_member_id 재stamp와 동일 관례)."""
    from app.services.gate_service import create_gate
    from app.models.gate import set_gate_status
    from datetime import datetime, timezone
    from sqlalchemy import select
    from app.models.gate import Gate

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_human(s, org_id, project_id, name="requester")
            old_designated = await _seed_human(s, org_id, project_id, name="old-po")
            new_designated = await _seed_human(s, org_id, project_id, name="new-po")
            work_item_id = uuid.uuid4()
            role_id = uuid.uuid4()

            first = await create_gate(
                s, org_id, work_item_id, "doc", "doc_approval",
                requester_id, role_id, project_id=project_id, notify=False,
                designated_approver_id=old_designated,
            )
            await s.commit()

            # 반려로 떨어뜨림(재오픈 경로를 타게).
            set_gate_status(first, "rejected", now=datetime.now(timezone.utc))
            first.resolver_id = requester_id
            first.resolved_at = datetime.now(timezone.utc)
            await s.commit()

            reopened = await create_gate(
                s, org_id, work_item_id, "doc", "doc_approval",
                requester_id, role_id, project_id=project_id, notify=False,
                designated_approver_id=new_designated,
            )
            await s.commit()

            assert reopened.id == first.id  # 같은 행 재사용(신규 row 아님).
            row = (await s.execute(select(Gate).where(Gate.id == first.id))).scalar_one()
            assert row.designated_approver_id == new_designated
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_notify_gate_card_recipients_resolved_reaches_both_action_and_informational():
    """AC2 — 해소 시 원 카드를 받았던 전원(액션+정보성 무관)에게 conversation.gate_resolved
    Event가 심긴다. 새 ConversationMessage는 생기지 않는다(챗버블 스팸 방지)."""
    from app.services.approval_delivery import dispatch_approval_request_cards, notify_gate_card_recipients_resolved
    from app.models.event import Event
    from app.models.conversation import ConversationMessage
    from sqlalchemy import select, func
    from datetime import datetime, timezone

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_human(s, org_id, project_id, name="requester")
            designated = await _seed_human(s, org_id, project_id, name="po")
            other = await _seed_human(s, org_id, project_id, name="teacher")
            doc = await _seed_doc(s, org_id, project_id)
            gate_id = uuid.uuid4()

            await dispatch_approval_request_cards(
                s, org_id=org_id, work_item_type="doc", work_item_id=doc.id,
                project_id=doc.project_id, title=doc.title, gate_id=gate_id,
                requester_id=requester_id, approver_ids=[designated, other],
                designated_approver_id=designated,
            )
            await s.commit()

            msg_count_before = (await s.execute(
                select(func.count()).select_from(ConversationMessage)
            )).scalar_one()

            resolved_at = datetime.now(timezone.utc)
            pushes = await notify_gate_card_recipients_resolved(
                s, org_id=org_id, gate_id=gate_id, status="approved",
                resolver_id=designated, resolved_at=resolved_at,
            )
            await s.commit()

            assert {p[0] for p in pushes} == {str(designated), str(other)}
            for _pid, payload in pushes:
                assert payload["gate_id"] == str(gate_id)
                assert payload["status"] == "approved"
                assert payload["resolver_id"] == str(designated)
                assert payload["event_type"] == "conversation.gate_resolved"

            events = (await s.execute(
                select(Event).where(Event.event_type == "conversation.gate_resolved")
            )).scalars().all()
            assert {e.recipient_id for e in events} == {designated, other}
            for e in events:
                assert e.payload["gate_id"] == str(gate_id)
                assert e.status == "pending"

            msg_count_after = (await s.execute(
                select(func.count()).select_from(ConversationMessage)
            )).scalar_one()
            assert msg_count_after == msg_count_before  # 새 챗 메시지 없음(순수 이벤트).
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_notify_gate_card_recipients_resolved_noop_when_no_cards():
    from app.services.approval_delivery import notify_gate_card_recipients_resolved
    from datetime import datetime, timezone

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org_project(s)
            pushes = await notify_gate_card_recipients_resolved(
                s, org_id=org_id, gate_id=uuid.uuid4(), status="approved",
                resolver_id=uuid.uuid4(), resolved_at=datetime.now(timezone.utc),
            )
            assert pushes == []
    finally:
        await engine.dispose()
