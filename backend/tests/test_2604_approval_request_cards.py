"""story #2604 P2(delivery-contract-blueprint-v0-1) — approval-request 챗 카드 배달(실 PG).

BE 절반: (1) 승인자별 DM get-or-create가 진짜 재사용/생성을 하는지, (2) 카드 메시지가
message_kind="request" + approval_target(work_item_id/gate_id/actions) 스키마로 실리는지,
(3) 승인자 1명 배달 실패가 다른 승인자·doc 상신 트랜잭션을 poison하지 않는지
([[feedback_savepoint_failopen_session_poison]] 클래스 회귀 방지) 검증.
"""
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

    org = Organization(id=uuid.uuid4(), name="Org2604", slug=f"org2604-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_human(session, org_id, project_id):
    from app.models.team import TeamMember

    m = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="human",
        name="requester", is_active=True,
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
async def test_dispatch_creates_dm_and_request_card_per_approver():
    from app.services.approval_delivery import dispatch_approval_request_cards
    from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_human(s, org_id, project_id)
            approver1 = await _seed_human(s, org_id, project_id)
            approver2 = await _seed_human(s, org_id, project_id)
            doc = await _seed_doc(s, org_id, project_id)
            gate_id = uuid.uuid4()

            await dispatch_approval_request_cards(
                s, org_id=org_id, work_item_type="doc", work_item_id=doc.id,
                project_id=doc.project_id, title=doc.title, gate_id=gate_id,
                requester_id=requester_id, approver_ids=[approver1, approver2],
            )
            await s.commit()

            from sqlalchemy import select

            convs = (await s.execute(select(Conversation).where(Conversation.org_id == org_id))).scalars().all()
            assert len(convs) == 2, "승인자 2명 → DM 2개(각자 스레드)"
            assert {c.type for c in convs} == {"dm"}

            msgs = (await s.execute(select(ConversationMessage))).scalars().all()
            assert len(msgs) == 2
            for msg in msgs:
                assert msg.msg_metadata["activation"]["kind"] == "request"
                assert msg.msg_metadata["activation"]["expects_response"] is True
                target = msg.msg_metadata["approval_target"]
                assert target["work_item_type"] == "doc"
                assert target["work_item_id"] == str(doc.id)
                assert target["gate_id"] == str(gate_id)
                assert target["actions"] == ["approve", "reject"]

            parts = (await s.execute(select(ConversationParticipant))).scalars().all()
            member_ids_per_conv: dict = {}
            for p in parts:
                member_ids_per_conv.setdefault(p.conversation_id, set()).add(p.member_id)
            for conv in convs:
                assert member_ids_per_conv[conv.id] == {requester_id, approver1} or \
                    member_ids_per_conv[conv.id] == {requester_id, approver2}
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_second_approval_reuses_existing_dm_not_new_room():
    """같은 requester↔approver 페어에 대해 두 번째 상신은 기존 DM을 재사용(카드가 매번 새 방으로
    흩어지면 승인자가 스레드를 잃는다) — 일반 create_conversation의 항상-신규 정책(EF-S2)과
    의도적으로 다른 지점(get-or-create 전용 경로)임을 잠근다."""
    from app.services.approval_delivery import dispatch_approval_request_cards
    from app.models.conversation import Conversation, ConversationMessage

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_human(s, org_id, project_id)
            approver_id = await _seed_human(s, org_id, project_id)
            doc1 = await _seed_doc(s, org_id, project_id, title="문서1")
            doc2 = await _seed_doc(s, org_id, project_id, title="문서2")

            await dispatch_approval_request_cards(
                s, org_id=org_id, work_item_type="doc", work_item_id=doc1.id,
                project_id=doc1.project_id, title=doc1.title, gate_id=uuid.uuid4(),
                requester_id=requester_id, approver_ids=[approver_id],
            )
            await s.commit()
            await dispatch_approval_request_cards(
                s, org_id=org_id, work_item_type="doc", work_item_id=doc2.id,
                project_id=doc2.project_id, title=doc2.title, gate_id=uuid.uuid4(),
                requester_id=requester_id, approver_ids=[approver_id],
            )
            await s.commit()

            from sqlalchemy import select

            convs = (await s.execute(select(Conversation).where(Conversation.org_id == org_id))).scalars().all()
            assert len(convs) == 1, "같은 pair 재상신 → DM 재사용(신규 방 생성 금지)"
            msgs = (await s.execute(select(ConversationMessage))).scalars().all()
            assert len(msgs) == 2, "카드 메시지는 방마다가 아니라 상신마다 1건씩 쌓인다"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_one_approver_failure_does_not_poison_session_for_others():
    """승인자 1명(존재하지 않는 member_id — FK 위반 유도)의 카드 배달이 실패해도, 세션이
    poison되지 않고 나머지 승인자 배달 + 이 함수를 부르는 트랜잭션의 후속 write가 그대로
    성공해야 한다(SAVEPOINT 격리 검증 — begin_nested 없으면 여기서 PendingRollbackError)."""
    from app.services.approval_delivery import dispatch_approval_request_cards
    from app.models.conversation import Conversation, ConversationMessage

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_human(s, org_id, project_id)
            good_approver = await _seed_human(s, org_id, project_id)
            nonexistent_approver = uuid.uuid4()  # team_members에 없음 → FK 위반 유도
            doc = await _seed_doc(s, org_id, project_id)

            await dispatch_approval_request_cards(
                s, org_id=org_id, work_item_type="doc", work_item_id=doc.id,
                project_id=doc.project_id, title=doc.title, gate_id=uuid.uuid4(),
                requester_id=requester_id, approver_ids=[nonexistent_approver, good_approver],
            )
            # poison 됐다면 이 commit이나 후속 write가 즉시 실패한다.
            await s.commit()

            from sqlalchemy import select

            convs = (await s.execute(select(Conversation).where(Conversation.org_id == org_id))).scalars().all()
            assert len(convs) == 1, "실패한 승인자는 방 생성 0, 성공한 승인자만 방 1개"
            msgs = (await s.execute(select(ConversationMessage))).scalars().all()
            assert len(msgs) == 1

            # 세션이 살아있음을 추가 write로 확인(poison이면 여기서 PendingRollbackError).
            from app.models.organization import Organization
            s.add(Organization(id=uuid.uuid4(), name="Sentinel", slug=f"sentinel-{uuid.uuid4().hex[:8]}"))
            await s.commit()
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_all_approvers_failing_logs_zero_delivery_warning(caplog):
    """story #d9c09f4b(2026-08-27, customer-zero) — recipients가 비지 않았는데도(위
    test_no_approvers_no_dm_created과 구분) 개별 승인자 전원이 실패하면, 지금까지는 각자
    "카드 배달 실패" WARNING만 나고 "그래서 결국 0건 착지했다"는 어디에도 안 남았다
    (성공과 전멸이 같은 무음). 전멸 전용 WARNING이 추가로 나야 한다."""
    import logging

    from app.services.approval_delivery import dispatch_approval_request_cards, logger as _logger

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_human(s, org_id, project_id)
            doc = await _seed_doc(s, org_id, project_id)
            # 둘 다 team_members에 없음 → 둘 다 FK 위반으로 실패(test_one_approver_failure의
            # nonexistent_approver 관례 재사용, 신규 실패유도 메커니즘 발명 0).
            nonexistent_1, nonexistent_2 = uuid.uuid4(), uuid.uuid4()

            with caplog.at_level(logging.WARNING, logger=_logger.name):
                await dispatch_approval_request_cards(
                    s, org_id=org_id, work_item_type="doc", work_item_id=doc.id,
                    project_id=doc.project_id, title=doc.title, gate_id=uuid.uuid4(),
                    requester_id=requester_id, approver_ids=[nonexistent_1, nonexistent_2],
                )
            await s.commit()

            from sqlalchemy import select
            from app.models.conversation import Conversation

            convs = (await s.execute(select(Conversation).where(Conversation.org_id == org_id))).scalars().all()
            assert convs == [], "전원 실패 — 방 자체가 하나도 안 생김"
            assert any("전멸" in r.message for r in caplog.records), \
                "recipients는 비지 않았는데 delivered_count==0인 전멸 케이스는 전용 WARNING이 나야 한다"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_partial_success_does_not_log_zero_delivery_warning(caplog):
    """1명이라도 성공하면(test_one_approver_failure_does_not_poison_session_for_others와
    동일 시드) 전멸 WARNING은 나지 않아야 한다 — 개별 실패 WARNING과 전멸 WARNING을
    혼동하면 성공 케이스까지 시끄러워진다(과잉 알림도 방어 대상)."""
    import logging

    from app.services.approval_delivery import dispatch_approval_request_cards, logger as _logger

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_human(s, org_id, project_id)
            good_approver = await _seed_human(s, org_id, project_id)
            nonexistent_approver = uuid.uuid4()
            doc = await _seed_doc(s, org_id, project_id)

            with caplog.at_level(logging.WARNING, logger=_logger.name):
                await dispatch_approval_request_cards(
                    s, org_id=org_id, work_item_type="doc", work_item_id=doc.id,
                    project_id=doc.project_id, title=doc.title, gate_id=uuid.uuid4(),
                    requester_id=requester_id, approver_ids=[nonexistent_approver, good_approver],
                )
            await s.commit()

            assert not any("전멸" in r.message for r in caplog.records)
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_no_approvers_no_dm_created(caplog):
    import logging

    from app.services.approval_delivery import dispatch_approval_request_cards, logger as _logger
    from app.models.conversation import Conversation

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_human(s, org_id, project_id)
            doc = await _seed_doc(s, org_id, project_id)

            with caplog.at_level(logging.WARNING, logger=_logger.name):
                await dispatch_approval_request_cards(
                    s, org_id=org_id, work_item_type="doc", work_item_id=doc.id,
                    project_id=doc.project_id, title=doc.title, gate_id=uuid.uuid4(),
                    requester_id=requester_id, approver_ids=[],
                )
            await s.commit()
            # story #d9c09f4b — "받을 사람이 원래 없었다"(project_id/approver_ids 가드)와
            # "recipients는 있었는데 전멸했다"(위 test_all_approvers_failing_...)는 서로 다른
            # 사실이라 같은 WARNING을 공유하면 안 된다.
            assert not any("전멸" in r.message for r in caplog.records)

            from sqlalchemy import select

            convs = (await s.execute(select(Conversation).where(Conversation.org_id == org_id))).scalars().all()
            assert convs == []
    finally:
        await engine.dispose()
