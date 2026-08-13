"""story #2628 — approval DM 재사용을 참가자 집합 기준으로(dm_pair_key 단독 매치 갭 수정).

선생님 실사용 사고 재현: 기존 requester↔approver 2인 dm이 dm_pair_key 없이(초기 생성·백필
갭) 존재해도 `_get_or_create_approval_dm`이 그 방을 찾아 재사용해야 한다 — 못 찾으면 새
방을 만들어 대화가 쪼개진다(97ee5509→59cda904 사고). 결과 회신(dispatch_approval_result_
reply)도 같은 헬퍼를 쓰므로 fix가 양방향에 동시 적용됨을 확인한다.
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

    org = Organization(id=uuid.uuid4(), name="Org2628", slug=f"org2628-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_member(session, org_id, project_id, *, member_type="human", name="m"):
    from app.models.team import TeamMember

    m = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type=member_type,
        name=name, is_active=True,
    )
    session.add(m)
    await session.commit()
    return m.id


async def _seed_dm_no_pair_key(session, org_id, project_id, member_ids, *, created_by):
    """dm_pair_key가 NULL인 기존 방 — 97ee5509류 초기 생성/백필 갭 재현."""
    from app.models.conversation import Conversation, ConversationParticipant

    conv = Conversation(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="dm",
        dm_pair_key=None, created_by=created_by,
    )
    session.add(conv)
    await session.flush()
    for mid in member_ids:
        session.add(ConversationParticipant(conversation_id=conv.id, member_id=mid))
    await session.commit()
    return conv.id


async def _seed_group(session, org_id, project_id, member_ids, *, created_by):
    from app.models.conversation import Conversation, ConversationParticipant

    conv = Conversation(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="group",
        created_by=created_by,
    )
    session.add(conv)
    await session.flush()
    for mid in member_ids:
        session.add(ConversationParticipant(conversation_id=conv.id, member_id=mid))
    await session.commit()
    return conv.id


async def _seed_dm_with_third_participant(session, org_id, project_id, member_ids, *, created_by):
    """type='dm'이지만 참가자가 3인 이상인 기형 데이터 — 오재사용 금지 확인용."""
    return await _seed_dm_no_pair_key(session, org_id, project_id, member_ids, created_by=created_by)


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_reuses_existing_dm_without_pair_key_ac1():
    """AC1 — 97ee5509 시나리오: dm_pair_key 없는 기존 2인 dm이 있으면 그 방을 재사용한다."""
    from app.services.approval_delivery import _get_or_create_approval_dm

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_member(s, org_id, project_id, name="requester")
            approver_id = await _seed_member(s, org_id, project_id, name="approver")
            legacy_conv_id = await _seed_dm_no_pair_key(
                s, org_id, project_id, [requester_id, approver_id], created_by=requester_id,
            )

            conv = await _get_or_create_approval_dm(
                s, org_id=org_id, project_id=project_id,
                requester_id=requester_id, approver_id=approver_id,
            )
            await s.commit()

            assert conv.id == legacy_conv_id, "dm_pair_key 없는 기존 방을 못 찾고 새로 만들면 안 된다"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_creates_new_dm_when_none_exists_then_reuses_it_ac2():
    """AC2 — 기존 방이 정말 없을 때만 신설, 신설 방은 이후 안정적으로 재사용된다."""
    from app.services.approval_delivery import _get_or_create_approval_dm
    from app.models.conversation import Conversation

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_member(s, org_id, project_id, name="requester")
            approver_id = await _seed_member(s, org_id, project_id, name="approver")

            conv1 = await _get_or_create_approval_dm(
                s, org_id=org_id, project_id=project_id,
                requester_id=requester_id, approver_id=approver_id,
            )
            await s.commit()
            conv2 = await _get_or_create_approval_dm(
                s, org_id=org_id, project_id=project_id,
                requester_id=requester_id, approver_id=approver_id,
            )
            await s.commit()

            assert conv1.id == conv2.id, "신설 방이 다음 호출에서 안정적으로 재사용돼야"

            from sqlalchemy import select
            all_convs = (await s.execute(
                select(Conversation).where(Conversation.org_id == org_id)
            )).scalars().all()
            assert len(all_convs) == 1
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_does_not_match_group_conversation_ac3():
    """AC3 — 같은 두 사람이 속한 group(3인 이상)은 매치 안 됨(오재사용 금지) — dm만 대상."""
    from app.services.approval_delivery import _get_or_create_approval_dm

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_member(s, org_id, project_id, name="requester")
            approver_id = await _seed_member(s, org_id, project_id, name="approver")
            third_id = await _seed_member(s, org_id, project_id, name="third")
            group_conv_id = await _seed_group(
                s, org_id, project_id, [requester_id, approver_id, third_id], created_by=requester_id,
            )

            conv = await _get_or_create_approval_dm(
                s, org_id=org_id, project_id=project_id,
                requester_id=requester_id, approver_id=approver_id,
            )
            await s.commit()

            assert conv.id != group_conv_id, "group 대화를 dm으로 오재사용하면 안 된다"
            assert conv.type == "dm"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_does_not_match_dm_with_third_participant_ac3():
    """AC3 — type='dm'이라도 참가자가 3인 이상(기형 데이터)이면 매치 안 됨."""
    from app.services.approval_delivery import _get_or_create_approval_dm

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_member(s, org_id, project_id, name="requester")
            approver_id = await _seed_member(s, org_id, project_id, name="approver")
            third_id = await _seed_member(s, org_id, project_id, name="third")
            malformed_conv_id = await _seed_dm_with_third_participant(
                s, org_id, project_id, [requester_id, approver_id, third_id], created_by=requester_id,
            )

            conv = await _get_or_create_approval_dm(
                s, org_id=org_id, project_id=project_id,
                requester_id=requester_id, approver_id=approver_id,
            )
            await s.commit()

            assert conv.id != malformed_conv_id, "3인 이상 dm(기형)은 오재사용하면 안 된다"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_does_not_match_different_pair_dm():
    """AC3 — requester가 겹쳐도 approver가 다른 기존 dm은 매치 안 됨(참가자 집합 불일치)."""
    from app.services.approval_delivery import _get_or_create_approval_dm

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_member(s, org_id, project_id, name="requester")
            approver_id = await _seed_member(s, org_id, project_id, name="approver")
            other_approver_id = await _seed_member(s, org_id, project_id, name="other")
            other_pair_conv_id = await _seed_dm_no_pair_key(
                s, org_id, project_id, [requester_id, other_approver_id], created_by=requester_id,
            )

            conv = await _get_or_create_approval_dm(
                s, org_id=org_id, project_id=project_id,
                requester_id=requester_id, approver_id=approver_id,
            )
            await s.commit()

            assert conv.id != other_pair_conv_id, "다른 approver와의 dm을 오재사용하면 안 된다"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_fix_applies_bidirectionally_request_and_result_reply():
    """양방향 동시 적용 확인 — dispatch_approval_request_cards(상신→승인자)와
    dispatch_approval_result_reply(해소→상신자)가 같은 _get_or_create_approval_dm을 쓰므로,
    dm_pair_key 없는 기존 방이 있으면 둘 다 그 방으로 간다(카드→회신이 같은 스레드에 쌓임)."""
    from app.services.approval_delivery import (
        dispatch_approval_request_cards,
        dispatch_approval_result_reply,
    )
    from app.models.conversation import Conversation, ConversationMessage
    from app.models.doc import Doc

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_member(s, org_id, project_id, name="requester")
            approver_id = await _seed_member(s, org_id, project_id, name="approver")
            legacy_conv_id = await _seed_dm_no_pair_key(
                s, org_id, project_id, [requester_id, approver_id], created_by=requester_id,
            )

            doc = Doc(
                id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="설계 문서",
                content="본문", status="pending", slug=f"doc-{uuid.uuid4().hex[:8]}",
            )
            s.add(doc)
            await s.commit()
            gate_id = uuid.uuid4()

            await dispatch_approval_request_cards(
                s, org_id=org_id, doc=doc, gate_id=gate_id,
                requester_id=requester_id, approver_ids=[approver_id],
            )
            await s.commit()
            await dispatch_approval_result_reply(
                s, org_id=org_id, doc=doc, gate_id=gate_id,
                requester_id=requester_id, resolver_id=approver_id,
                decision="approved", resolution_note=None,
            )
            await s.commit()

            from sqlalchemy import select

            convs = (await s.execute(select(Conversation).where(Conversation.org_id == org_id))).scalars().all()
            assert len(convs) == 1, "카드·회신 둘 다 기존 방으로 가야(신규 방 생성 0)"
            assert convs[0].id == legacy_conv_id

            msgs = (await s.execute(
                select(ConversationMessage).where(ConversationMessage.conversation_id == legacy_conv_id)
            )).scalars().all()
            assert len(msgs) == 2, "카드 1건 + 회신 1건이 같은 기존 방에 쌓여야"
    finally:
        await engine.dispose()
