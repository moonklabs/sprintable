"""story #1992: GET /api/v2/conversations/unread-count — GNB 채팅 unread 총합(count-only)
realPG 통합 테스트.

story #1976(read state 서버 truth)이 만든 `_list_unread_counts_stmt`(list_conversations
배치 unread_count SSOT)를 확장한 `_total_unread_count_stmt`가 caller의 전 참여 대화
unread_count를 정확히 SUM하는지 실증. 커버:
- 대화 3개(unread 3 + 0 + 2) → total=5.
- mark-read 후 total 감소.
- 본인 발신 메시지 제외(`IS DISTINCT FROM`).
- 비참여 대화는 total에 미포함.
- N+1 방지(참여 대화 수 늘어도 쿼리 수 고정).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _make_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org, project


async def _make_human_member(session, org_id, project_id):
    from app.models.member import Member
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user_id = uuid.uuid4()
    user = User(id=user_id, email=f"human-{user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(user)
    await session.commit()
    m = Member(id=uuid.uuid4(), org_id=org_id, type="human", user_id=user_id, name=f"M-{user_id.hex[:6]}")
    session.add(m)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, member_id=m.id, permission="granted", role="member",
    ))
    await session.commit()
    return m.id, user_id


async def _make_conversation(session, org_id, project_id, member_ids, created_by):
    from app.models.conversation import Conversation, ConversationParticipant

    conv = Conversation(
        id=uuid.uuid4(), project_id=project_id, org_id=org_id, type="group",
        title="Test convo", created_by=created_by,
    )
    session.add(conv)
    await session.flush()
    for mid in member_ids:
        session.add(ConversationParticipant(conversation_id=conv.id, member_id=mid))
    await session.commit()
    return conv.id


async def _add_message(session, conv_id, sender_id, content: str, created_at: datetime):
    from app.models.conversation import ConversationMessage
    msg = ConversationMessage(
        id=uuid.uuid4(), conversation_id=conv_id, sender_id=sender_id,
        content=content, created_at=created_at,
    )
    session.add(msg)
    await session.commit()
    return msg


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app_human(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(
            user_id=str(user_id), email="human@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


T0 = datetime(2026, 7, 17, 8, 0, 0, tzinfo=timezone.utc)


def _t(minutes: int) -> datetime:
    return T0 + timedelta(minutes=minutes)


async def _seed_three_conversations(session):
    """org(1) + project(1) + me + other. 대화 A(unread 3) + 대화 B(unread 0, 내가 이미 다 읽음)
    + 대화 C(unread 2). A/B/C 전부 me+other 2인 group. 반환: org_id/project_id/me/other/user_id_me/
    conv_ids(dict)."""
    org, project = await _make_org_project(session)
    me, user_id_me = await _make_human_member(session, org.id, project.id)
    other, _user_id_other = await _make_human_member(session, org.id, project.id)

    conv_a = await _make_conversation(session, org.id, project.id, [me, other], created_by=me)
    await _add_message(session, conv_a, other, "A-msg1", _t(1))
    await _add_message(session, conv_a, other, "A-msg2", _t(2))
    await _add_message(session, conv_a, other, "A-msg3", _t(3))
    # 본인 발신 메시지도 섞는다 — total에서 제외돼야 함(회귀 감지용).
    await _add_message(session, conv_a, me, "A-mine", _t(4))

    conv_b = await _make_conversation(session, org.id, project.id, [me, other], created_by=me)
    await _add_message(session, conv_b, other, "B-msg1", _t(1))
    # conv_b는 내가 이미 다 읽은 상태로 만든다(last_read_at을 미래로 세팅) — unread 0.
    from app.models.conversation import ConversationParticipant
    from sqlalchemy import update
    await session.execute(
        update(ConversationParticipant)
        .where(
            ConversationParticipant.conversation_id == conv_b,
            ConversationParticipant.member_id == me,
        )
        .values(last_read_at=_t(100))
    )
    await session.commit()

    conv_c = await _make_conversation(session, org.id, project.id, [me, other], created_by=me)
    await _add_message(session, conv_c, other, "C-msg1", _t(1))
    await _add_message(session, conv_c, other, "C-msg2", _t(2))

    return {
        "org_id": org.id, "project_id": project.id, "me": me, "other": other,
        "user_id_me": user_id_me,
        "conv_a": conv_a, "conv_b": conv_b, "conv_c": conv_c,
    }


# ─── AC3 done-gate: total=5 (3 + 0 + 2), 본인 제외, mark-read 후 감소, 비참여 제외 ──────

@pytest.mark.anyio
async def test_unread_count_total_sums_across_all_participating_conversations():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_three_conversations(s)

        await _setup_app_human(app, Session, seeded["user_id_me"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/conversations/unread-count")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            # count-only: total 외 다른 필드(제목/참가자 등) 없어야 함.
            assert set(body.keys()) == {"count"}, body
            assert body["count"] == 5, body  # A:3(본인발신 1건 제외) + B:0 + C:2
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unread_count_total_decreases_after_mark_read():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_three_conversations(s)

        await _setup_app_human(app, Session, seeded["user_id_me"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp0 = await client.get("/api/v2/conversations/unread-count")
            assert resp0.json()["count"] == 5, resp0.json()

            # conv_a 전체 read 처리 (unread 3 -> 0).
            mark_resp = await client.post(
                f"/api/v2/conversations/{seeded['conv_a']}/read", json={},
            )
            assert mark_resp.status_code == 200, mark_resp.text

            resp1 = await client.get("/api/v2/conversations/unread-count")
            assert resp1.status_code == 200, resp1.text
            assert resp1.json()["count"] == 2, resp1.json()  # C만 남음
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unread_count_total_excludes_non_participating_conversation():
    """caller가 참여하지 않는 대화(제3자 group)는 total에 전혀 반영되지 않아야 한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_three_conversations(s)
            # 제3자 전용 대화(caller 미참여) — unread가 있어도 caller total에 안 들어가야.
            third, _third_user_id = await _make_human_member(s, seeded["org_id"], seeded["project_id"])
            fourth, _fourth_user_id = await _make_human_member(s, seeded["org_id"], seeded["project_id"])
            other_conv = await _make_conversation(
                s, seeded["org_id"], seeded["project_id"], [third, fourth], created_by=third,
            )
            await _add_message(s, other_conv, fourth, "not-mine", _t(1))

        await _setup_app_human(app, Session, seeded["user_id_me"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/conversations/unread-count")
            assert resp.status_code == 200, resp.text
            assert resp.json()["count"] == 5, resp.json()  # 제3자 대화 미반영, 여전히 5
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unread_count_total_zero_when_no_conversations():
    """참여 대화가 전무한 caller는 total=0(INNER JOIN 서브쿼리 0행 → COALESCE(SUM,0) 정규화)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _make_org_project(s)
            me, user_id_me = await _make_human_member(s, org.id, project.id)

        await _setup_app_human(app, Session, user_id_me, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/conversations/unread-count")
            assert resp.status_code == 200, resp.text
            assert resp.json()["count"] == 0, resp.json()
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── N+1 방지: 참여 대화 수가 늘어도 unread-count 쿼리는 정확히 1회 ─────────────

@pytest.mark.anyio
async def test_unread_count_total_single_query_not_n_plus_1():
    from app.main import app
    from sqlalchemy import event

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _make_org_project(s)
            me, user_id_me = await _make_human_member(s, org.id, project.id)
            other, _ = await _make_human_member(s, org.id, project.id)

            conv_ids = []
            for i in range(5):
                conv_id = await _make_conversation(s, org.id, project.id, [me, other], created_by=me)
                await _add_message(s, conv_id, other, f"unread in convo {i}", _t(i))
                conv_ids.append(conv_id)

        await _setup_app_human(app, Session, user_id_me, org.id)
        client = _client_for(app)

        unread_query_count = 0

        def _before_cursor_execute(conn, cursor, statement, parameters, context, executemany):
            nonlocal unread_query_count
            low = statement.lower()
            if "join conversation_messages" in low and "group by" in low:
                unread_query_count += 1

        event.listen(engine.sync_engine, "before_cursor_execute", _before_cursor_execute)
        try:
            resp = await client.get("/api/v2/conversations/unread-count")
            assert resp.status_code == 200, resp.text
            assert resp.json()["count"] == 5, resp.json()
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", _before_cursor_execute)
            await client.aclose()

        assert unread_query_count == 1, (
            f"unread-count total 쿼리가 {unread_query_count}회 실행됨(N+1 의심, 대화 5개)"
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
