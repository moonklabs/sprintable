"""story #2665(#2664 후속) — GET /api/v2/events/definitions/publish-history.

발행 기록이 별도 테이블이 아니라 conversation_messages.msg_metadata['event']['event_key']
에만 존재한다(#2637 AC 0-a) — 그 SSOT를 definition_key 축으로 조회하는 신규 엔드포인트.

검증 축:
- AC1: definition_key로 최근 발행 이력(발행자·시각·도달 conv) 조회.
- org 스코프: 다른 org의 같은 event_key 발행분이 새지 않는다(conversations.org_id JOIN).
- 양성대조: metadata 없는 일반 메시지·다른 event_key 발행분이 섞여 있어도 정확히 걸러진다.
- limit 적용 + 최신순 정렬.
- org admin/owner 전용(비-admin 403).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

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


async def _seed_org(session, *, slug):
    from app.models.organization import Organization
    org = Organization(id=uuid.uuid4(), name=f"Org-{slug}", slug=slug)
    session.add(org)
    await session.commit()
    return org.id


async def _seed_org_member(session, org_id, *, role="admin", name="Admin"):
    from app.models.project import OrgMember
    user_id = uuid.uuid4()
    session.add(OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user_id, role=role))
    await session.commit()
    return user_id


async def _seed_project(session, org_id, *, name="Proj"):
    from app.models.project import Project
    project = Project(id=uuid.uuid4(), org_id=org_id, name=name)
    session.add(project)
    await session.commit()
    return project.id


async def _seed_team_member(session, org_id, project_id, *, member_id=None, name="Sender", mtype="agent"):
    """story #2665 — conversation_messages.sender_id는 team_members.id FK다(member SSOT
    이관 중이라도 이 컬럼은 아직 레거시 축·member_ssot_resolver_shadow 기본 False라
    lookup_members_by_ids도 이 테이블을 우선 읽는다)."""
    from app.models.team import TeamMember
    tm = TeamMember(
        id=member_id or uuid.uuid4(), org_id=org_id, project_id=project_id, type=mtype, name=name,
    )
    session.add(tm)
    await session.commit()
    return tm.id


async def _seed_conversation(session, org_id, project_id, *, title="Conv"):
    from app.models.conversation import Conversation
    conv = Conversation(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="group", title=title)
    session.add(conv)
    await session.commit()
    return conv.id


async def _seed_message(session, conversation_id, *, sender_id=None, event_key=None, created_at=None, content="x"):
    from app.models.conversation import ConversationMessage
    msg_metadata = {"event": {"event_key": event_key, "payload": {}}} if event_key else None
    msg = ConversationMessage(
        id=uuid.uuid4(), conversation_id=conversation_id, sender_id=sender_id, content=content,
        msg_metadata=msg_metadata,
    )
    session.add(msg)
    await session.flush()
    if created_at is not None:
        # created_at은 TimestampMixin server_default라 직접 대입 후 명시 UPDATE로 확定해야
        # ORM insert가 server_default를 덮어쓰지 않는다(정렬/필터 테스트에 상대 시각差가 필요).
        from sqlalchemy import update
        from app.models.conversation import ConversationMessage as CM
        await session.execute(update(CM).where(CM.id == msg.id).values(created_at=created_at))
    await session.commit()
    return msg.id


def _human_auth(user_id: uuid.UUID, org_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(user_id), email="admin@example.com",
        claims={"app_metadata": {"org_id": str(org_id)}}, org_id=str(org_id),
    )


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_history_filters_by_event_key_and_excludes_plain_messages():
    from app.routers.events import get_event_publish_history

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s, slug="acme1")
            admin_id = await _seed_org_member(s, org_id)
            project_id = await _seed_project(s, org_id)
            conv_id = await _seed_conversation(s, org_id, project_id)

            sender_id = await _seed_team_member(s, org_id, project_id)
            target_msg_id = await _seed_message(s, conv_id, sender_id=sender_id, event_key="org.acme1.work.decision")
            await _seed_message(s, conv_id, sender_id=sender_id, event_key="org.acme1.work.other")
            await _seed_message(s, conv_id, sender_id=sender_id, event_key=None)  # 평문 메시지

            result = await get_event_publish_history(
                definition_key="org.acme1.work.decision", limit=20,
                db=s, auth=_human_auth(admin_id, org_id), org_id=org_id,
            )
            assert len(result) == 1
            assert result[0].id == str(target_msg_id)
            assert result[0].conversation_id == str(conv_id)
            assert result[0].sender_id == str(sender_id)
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_history_excludes_other_org_same_event_key():
    """IDOR 회귀가드 — 같은 event_key라도 다른 org의 대화에서 발행된 것은 안 보인다."""
    from app.routers.events import get_event_publish_history

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_a = await _seed_org(s, slug="acme2a")
            org_b = await _seed_org(s, slug="acme2b")
            admin_a = await _seed_org_member(s, org_a)
            project_a = await _seed_project(s, org_a)
            project_b = await _seed_project(s, org_b)
            conv_a = await _seed_conversation(s, org_a, project_a)
            conv_b = await _seed_conversation(s, org_b, project_b)

            await _seed_message(s, conv_a, event_key="preset.gate.verdict")
            await _seed_message(s, conv_b, event_key="preset.gate.verdict")

            result = await get_event_publish_history(
                definition_key="preset.gate.verdict", limit=20,
                db=s, auth=_human_auth(admin_a, org_a), org_id=org_a,
            )
            assert len(result) == 1
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_history_orders_newest_first_and_respects_limit():
    from app.routers.events import get_event_publish_history

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s, slug="acme3")
            admin_id = await _seed_org_member(s, org_id)
            project_id = await _seed_project(s, org_id)
            conv_id = await _seed_conversation(s, org_id, project_id)

            base = datetime(2026, 8, 15, 12, 0, 0, tzinfo=timezone.utc)
            ids = []
            for i in range(5):
                mid = await _seed_message(
                    s, conv_id, event_key="preset.gate.verdict",
                    created_at=base + timedelta(minutes=i),
                )
                ids.append(mid)
            # ids[4]가 최신(가장 늦은 created_at) — 역순 기대.

            result = await get_event_publish_history(
                definition_key="preset.gate.verdict", limit=3,
                db=s, auth=_human_auth(admin_id, org_id), org_id=org_id,
            )
            assert [r.id for r in result] == [str(ids[4]), str(ids[3]), str(ids[2])]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_history_enriches_sender_name():
    from app.routers.events import get_event_publish_history

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s, slug="acme4")
            admin_id = await _seed_org_member(s, org_id)
            project_id = await _seed_project(s, org_id)
            conv_id = await _seed_conversation(s, org_id, project_id)

            sender_id = await _seed_team_member(s, org_id, project_id, name="페드루 올리베이라")
            await _seed_message(s, conv_id, sender_id=sender_id, event_key="preset.gate.verdict")

            result = await get_event_publish_history(
                definition_key="preset.gate.verdict", limit=20,
                db=s, auth=_human_auth(admin_id, org_id), org_id=org_id,
            )
            assert result[0].sender_name == "페드루 올리베이라"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_history_no_matches_returns_empty_list():
    from app.routers.events import get_event_publish_history

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s, slug="acme5")
            admin_id = await _seed_org_member(s, org_id)

            result = await get_event_publish_history(
                definition_key="preset.gate.verdict", limit=20,
                db=s, auth=_human_auth(admin_id, org_id), org_id=org_id,
            )
            assert result == []
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_history_non_admin_403():
    from fastapi import HTTPException
    from app.routers.events import get_event_publish_history

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s, slug="acme6")
            member_id = await _seed_org_member(s, org_id, role="member")

            with pytest.raises(HTTPException) as ei:
                await get_event_publish_history(
                    definition_key="preset.gate.verdict", limit=20,
                    db=s, auth=_human_auth(member_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 403
    finally:
        await engine.dispose()
