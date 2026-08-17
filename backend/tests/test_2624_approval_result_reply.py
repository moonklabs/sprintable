"""story #2624 — 결재 해소 결과의 상신자 회신(실 PG).

dispatch_approval_request_cards(#2604 P2, 상신→승인자)의 반대 방향: 해소 결과가
상신자↔해소자 DM에 message_kind="result" 카드로 게시되고 기존 _dispatch_conversation_event
로 메인 dispatch(agent 상신자가 이 경로로 결과를 받는다, AC1) + human 상신자는 벨 알림까지
(agent는 기존 관례대로 벨 대상에서 제외) + 해소자 본인=상신자면 자기-알림 스킵(AC3).
"""
from __future__ import annotations

import os
import uuid

from unittest.mock import AsyncMock, patch

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

    org = Organization(id=uuid.uuid4(), name="Org2624", slug=f"org2624-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_member(session, org_id, project_id, *, member_type, name="member"):
    from app.models.team import TeamMember

    m = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type=member_type,
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
async def test_human_requester_gets_dm_and_bell():
    from app.services.approval_delivery import dispatch_approval_result_reply
    from app.models.conversation import Conversation, ConversationMessage

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_member(s, org_id, project_id, member_type="human", name="requester")
            resolver_id = await _seed_member(s, org_id, project_id, member_type="human", name="resolver")
            doc = await _seed_doc(s, org_id, project_id)
            gate_id = uuid.uuid4()

            dn = AsyncMock()
            import app.services.notification_dispatch as nd_mod
            orig = nd_mod.dispatch_notification
            nd_mod.dispatch_notification = dn
            try:
                await dispatch_approval_result_reply(
                    s, org_id=org_id, work_item_type="doc", work_item_id=doc.id, project_id=project_id, title=doc.title, gate_id=gate_id,
                    requester_id=requester_id, resolver_id=resolver_id,
                    decision="rejected", resolution_note="사유: 재작성 필요",
                )
                await s.commit()
            finally:
                nd_mod.dispatch_notification = orig

            dn.assert_awaited_once()
            kw = dn.await_args.kwargs
            assert kw["target_member_ids"] == [requester_id]
            assert kw["event_type"] == "doc_approval_resolved"
            assert kw["reference_id"] == gate_id

            from sqlalchemy import select

            convs = (await s.execute(select(Conversation).where(Conversation.org_id == org_id))).scalars().all()
            assert len(convs) == 1
            assert convs[0].type == "dm"

            msgs = (await s.execute(select(ConversationMessage))).scalars().all()
            assert len(msgs) == 1
            msg = msgs[0]
            assert msg.sender_id == resolver_id
            assert msg.msg_metadata["activation"]["kind"] == "result"
            target = msg.msg_metadata["approval_target"]
            assert target["decision"] == "rejected"
            assert target["resolution_note"] == "사유: 재작성 필요"
            assert target["gate_id"] == str(gate_id)
            assert "재작성 필요" in msg.content
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_agent_requester_gets_dm_but_no_bell():
    """agent 상신자는 메인 dispatch(Event) 경로로 결과를 받는다 — 벨 알림(dispatch_notification)
    대상에서는 기존 관례대로 제외(approval_delivery.dispatch_approval_request_cards와 동일
    human-only 비대칭)."""
    from app.services.approval_delivery import dispatch_approval_result_reply
    from app.models.conversation import ConversationMessage
    from app.models.event import Event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_member(s, org_id, project_id, member_type="agent", name="po-agent")
            resolver_id = await _seed_member(s, org_id, project_id, member_type="human", name="resolver")
            doc = await _seed_doc(s, org_id, project_id)
            gate_id = uuid.uuid4()

            dn = AsyncMock()
            import app.services.notification_dispatch as nd_mod
            orig = nd_mod.dispatch_notification
            nd_mod.dispatch_notification = dn
            try:
                await dispatch_approval_result_reply(
                    s, org_id=org_id, work_item_type="doc", work_item_id=doc.id, project_id=project_id, title=doc.title, gate_id=gate_id,
                    requester_id=requester_id, resolver_id=resolver_id,
                    decision="approved", resolution_note=None,
                )
                await s.commit()
            finally:
                nd_mod.dispatch_notification = orig

            dn.assert_not_awaited(), "agent 상신자는 벨 대상이 아니어야(메인 dispatch로 충분)"

            from sqlalchemy import select

            msgs = (await s.execute(select(ConversationMessage))).scalars().all()
            assert len(msgs) == 1

            events = (await s.execute(
                select(Event).where(Event.source_entity_id == msgs[0].id, Event.recipient_id == requester_id)
            )).scalars().all()
            assert len(events) == 1, "agent 상신자에게 메인 dispatch Event가 생성돼야(AC1)"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_self_resolve_skips_notification():
    """해소자 본인이 상신자인 경우(SoD가 정상적으로 막지만 방어심층) 자기-알림 스킵(AC3)."""
    from app.services.approval_delivery import dispatch_approval_result_reply
    from app.models.conversation import Conversation

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            same_id = await _seed_member(s, org_id, project_id, member_type="human", name="self")
            doc = await _seed_doc(s, org_id, project_id)

            await dispatch_approval_result_reply(
                s, org_id=org_id, work_item_type="doc", work_item_id=doc.id, project_id=project_id, title=doc.title, gate_id=uuid.uuid4(),
                requester_id=same_id, resolver_id=same_id,
                decision="approved", resolution_note=None,
            )
            await s.commit()

            from sqlalchemy import select

            convs = (await s.execute(select(Conversation).where(Conversation.org_id == org_id))).scalars().all()
            assert convs == [], "해소자=상신자인데 회신 대화가 생성되면 안 된다"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_second_resolution_reuses_existing_dm():
    """같은 requester↔resolver 페어의 두 번째 회신(다른 doc)은 기존 DM을 재사용한다 —
    dispatch_approval_request_cards의 get-or-create와 동일 관례(#2604)."""
    from app.services.approval_delivery import dispatch_approval_result_reply
    from app.models.conversation import Conversation, ConversationMessage

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_member(s, org_id, project_id, member_type="human", name="requester")
            resolver_id = await _seed_member(s, org_id, project_id, member_type="human", name="resolver")
            doc1 = await _seed_doc(s, org_id, project_id, title="문서1")
            doc2 = await _seed_doc(s, org_id, project_id, title="문서2")

            await dispatch_approval_result_reply(
                s, org_id=org_id, work_item_type="doc", work_item_id=doc1.id, project_id=project_id, title=doc1.title, gate_id=uuid.uuid4(),
                requester_id=requester_id, resolver_id=resolver_id,
                decision="approved", resolution_note=None,
            )
            await s.commit()
            await dispatch_approval_result_reply(
                s, org_id=org_id, work_item_type="doc", work_item_id=doc2.id, project_id=project_id, title=doc2.title, gate_id=uuid.uuid4(),
                requester_id=requester_id, resolver_id=resolver_id,
                decision="rejected", resolution_note="두번째",
            )
            await s.commit()

            from sqlalchemy import select

            convs = (await s.execute(select(Conversation).where(Conversation.org_id == org_id))).scalars().all()
            assert len(convs) == 1
            msgs = (await s.execute(select(ConversationMessage))).scalars().all()
            assert len(msgs) == 2
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_dm_delivery_failure_does_not_block_bell_notification():
    """카디르 QA(#3015): DM 배달 블록의 except가 조기 return을 하면 벨 알림까지 같이
    죽어 「폴링 없인 결과 모름」이 그 실패모드에서 재발한다 — 이 PR이 막으려던 바로 그
    문제. DM dispatch(_dispatch_conversation_event)가 SQL 레벨에서 실패해도 human
    상신자의 벨 알림은 독립적으로 시도돼야 한다(형제 try/except, 단방향 의존 금지)."""
    from app.services.approval_delivery import dispatch_approval_result_reply

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_member(s, org_id, project_id, member_type="human", name="requester")
            resolver_id = await _seed_member(s, org_id, project_id, member_type="human", name="resolver")
            doc = await _seed_doc(s, org_id, project_id)
            gate_id = uuid.uuid4()

            dn = AsyncMock()
            import app.services.notification_dispatch as nd_mod
            orig = nd_mod.dispatch_notification
            nd_mod.dispatch_notification = dn
            try:
                with patch(
                    "app.routers.conversations._dispatch_conversation_event",
                    new=AsyncMock(side_effect=RuntimeError("DM dispatch boom")),
                ):
                    await dispatch_approval_result_reply(
                        s, org_id=org_id, work_item_type="doc", work_item_id=doc.id, project_id=project_id, title=doc.title, gate_id=gate_id,
                        requester_id=requester_id, resolver_id=resolver_id,
                        decision="rejected", resolution_note="사유",
                    )
                await s.commit()
            finally:
                nd_mod.dispatch_notification = orig

            dn.assert_awaited_once(), (
                "DM dispatch 실패가 벨 알림까지 막으면 안 된다 — 형제 try/except 위반"
            )
            kw = dn.await_args.kwargs
            assert kw["target_member_ids"] == [requester_id]
            assert kw["event_type"] == "doc_approval_resolved"
    finally:
        await engine.dispose()
