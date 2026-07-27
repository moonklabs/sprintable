"""story #1976 (E-CHAT-REALTIME 트랙A): read state 서버 truth — realPG 통합 테스트.

doc chat-realtime-track-a-read-state-design(§3 mark-read 계약/§4 unread_count/§5 SSE)의
실 구현 실증. 커버:
- unread_count 정의(last_read_at 이후 & sender IS DISTINCT FROM 나) — NULL 케이스 포함.
- mark-read up_to 지정/생략(now() 폴백) 계약.
- GREATEST 래칫 — 멱등 + 역행 방지.
- list_conversations unread_count 단일 JOIN+GROUP BY(N+1 방지) 쿼리수 실측.
- conversation.read SSE — 본인의 타 커넥션에만 전파(다른 유저 미수신 실측).
- 비참여자 403.
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


async def _seed_conversation(session, *, n_members: int = 2):
    """org(1) + project(1) + n_members human members(project_access member) + 1 group conversation
    (전원 참가). 반환: org_id/project_id/conv_id/member_ids(list)/user_ids(list, member 순서 대응)."""
    from app.models.conversation import Conversation, ConversationParticipant
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    member_ids = []
    user_ids = []
    for i in range(n_members):
        user_id = uuid.uuid4()
        user = User(id=user_id, email=f"human-{user_id.hex[:8]}@test.com", hashed_password="x")
        session.add(user)
        await session.commit()
        m = Member(id=uuid.uuid4(), org_id=org.id, type="human", user_id=user_id, name=f"Member{i}")
        session.add(m)
        await session.commit()
        session.add(ProjectAccess(
            id=uuid.uuid4(), project_id=project.id, member_id=m.id, permission="granted", role="member",
        ))
        await session.commit()
        member_ids.append(m.id)
        user_ids.append(user_id)

    conv = Conversation(
        id=uuid.uuid4(), project_id=project.id, org_id=org.id, type="group",
        title="Test convo", created_by=member_ids[0],
    )
    session.add(conv)
    await session.flush()
    for mid in member_ids:
        session.add(ConversationParticipant(conversation_id=conv.id, member_id=mid))
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "conv_id": conv.id,
        "member_ids": member_ids, "user_ids": user_ids,
    }


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


# ─── unread_count 정의: last_read_at 이후 & sender IS DISTINCT FROM 나 ───────

@pytest.mark.anyio
async def test_unread_count_excludes_own_messages_includes_others():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_conversation(s, n_members=2)
            me, other = seeded["member_ids"]
            await _add_message(s, seeded["conv_id"], me, "내 메시지", _t(0))
            await _add_message(s, seeded["conv_id"], other, "상대 메시지1", _t(1))
            await _add_message(s, seeded["conv_id"], other, "상대 메시지2", _t(2))

        await _setup_app_human(app, Session, seeded["user_ids"][0], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/conversations/{seeded['conv_id']}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["last_read_at"] is None
            # last_read_at NULL(한 번도 안 읽음) → 전체 3건 중 내 발신 1건 제외 = 2건
            assert body["unread_count"] == 2, body
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unread_count_null_sender_counts_as_unread():
    """IS DISTINCT FROM 함정 실증: sender_id NULL(발신자 탈퇴) 메시지도 '나 아님'이라 unread에
    포함돼야 한다 — `!=` 였다면 3-값 논리로 조용히 누락됐을 케이스."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_conversation(s, n_members=2)
            me, other = seeded["member_ids"]
            await _add_message(s, seeded["conv_id"], None, "발신자 소실 메시지", _t(0))

        await _setup_app_human(app, Session, seeded["user_ids"][0], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/conversations/{seeded['conv_id']}")
            assert resp.status_code == 200, resp.text
            assert resp.json()["unread_count"] == 1, resp.json()
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── mark-read: up_to 지정 / 생략(now 폴백) / 멱등 / GREATEST 래칫 ───────────

@pytest.mark.anyio
async def test_mark_read_with_up_to_sets_exact_value_and_recomputes_unread():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_conversation(s, n_members=2)
            me, other = seeded["member_ids"]
            await _add_message(s, seeded["conv_id"], other, "msg1", _t(1))
            await _add_message(s, seeded["conv_id"], other, "msg2", _t(2))
            await _add_message(s, seeded["conv_id"], other, "msg3", _t(3))

        await _setup_app_human(app, Session, seeded["user_ids"][0], seeded["org_id"])
        client = _client_for(app)
        try:
            up_to = _t(2).isoformat()
            resp = await client.post(
                f"/api/v2/conversations/{seeded['conv_id']}/read", json={"up_to": up_to},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["last_read_at"].startswith("2026-07-17T08:02:00")
            # msg1,msg2(<=up_to) 읽음 처리, msg3(>up_to)만 unread
            assert body["unread_count"] == 1, body

            # 상세 조회로도 동일 값 재확인(GET이 같은 로직 재사용).
            resp2 = await client.get(f"/api/v2/conversations/{seeded['conv_id']}")
            assert resp2.json()["unread_count"] == 1
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_mark_read_without_up_to_uses_now_mark_all_read():
    """up_to 생략 = "전체 읽음"(mark-all-read) 의도 — 서버 now()로 SET, 기존 메시지 전부 read."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_conversation(s, n_members=2)
            me, other = seeded["member_ids"]
            await _add_message(s, seeded["conv_id"], other, "msg1", _t(1))
            await _add_message(s, seeded["conv_id"], other, "msg2", _t(2))

        await _setup_app_human(app, Session, seeded["user_ids"][0], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/conversations/{seeded['conv_id']}/read", json={})
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["unread_count"] == 0, body
            # last_read_at ~= now(), 훨씬 미래(2026-07-17 8시대 seed보다 한참 뒤)여야.
            last_read_at = datetime.fromisoformat(body["last_read_at"])
            assert last_read_at > _t(2)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_mark_read_greatest_ratchet_prevents_regression():
    """역행 방지 실증: 최신 up_to로 mark-read한 뒤, 더 과거 up_to로 재호출해도 last_read_at이
    줄어들지 않는다(GREATEST 래칫, §4-3)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_conversation(s, n_members=2)
            me, other = seeded["member_ids"]
            await _add_message(s, seeded["conv_id"], other, "msg1", _t(1))
            await _add_message(s, seeded["conv_id"], other, "msg2", _t(2))
            await _add_message(s, seeded["conv_id"], other, "msg3", _t(3))

        await _setup_app_human(app, Session, seeded["user_ids"][0], seeded["org_id"])
        client = _client_for(app)
        try:
            # 먼저 최신 시각(t3)으로 mark-read.
            resp1 = await client.post(
                f"/api/v2/conversations/{seeded['conv_id']}/read",
                json={"up_to": _t(3).isoformat()},
            )
            assert resp1.status_code == 200, resp1.text
            assert resp1.json()["unread_count"] == 0

            # 더 과거 시각(t1)으로 역행 시도 — last_read_at 이 t3에서 줄어들면 안 됨.
            resp2 = await client.post(
                f"/api/v2/conversations/{seeded['conv_id']}/read",
                json={"up_to": _t(1).isoformat()},
            )
            assert resp2.status_code == 200, resp2.text
            body2 = resp2.json()
            assert body2["last_read_at"].startswith("2026-07-17T08:03:00"), body2  # 여전히 t3
            assert body2["unread_count"] == 0, body2  # 역행 안 됐으니 여전히 0(다시 unread로 안 보임)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_mark_read_idempotent_repeated_calls_same_up_to():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_conversation(s, n_members=2)
            me, other = seeded["member_ids"]
            await _add_message(s, seeded["conv_id"], other, "msg1", _t(1))

        await _setup_app_human(app, Session, seeded["user_ids"][0], seeded["org_id"])
        client = _client_for(app)
        try:
            up_to = _t(1).isoformat()
            r1 = await client.post(f"/api/v2/conversations/{seeded['conv_id']}/read", json={"up_to": up_to})
            r2 = await client.post(f"/api/v2/conversations/{seeded['conv_id']}/read", json={"up_to": up_to})
            r3 = await client.post(f"/api/v2/conversations/{seeded['conv_id']}/read", json={"up_to": up_to})
            for r in (r1, r2, r3):
                assert r.status_code == 200, r.text
            assert r1.json()["last_read_at"] == r2.json()["last_read_at"] == r3.json()["last_read_at"]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_mark_read_non_participant_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_conversation(s, n_members=2)
            from app.models.member import Member
            from app.models.user import User
            outsider_user_id = uuid.uuid4()
            s.add(User(
                id=outsider_user_id, email=f"outsider-{outsider_user_id.hex[:8]}@test.com",
                hashed_password="x",
            ))
            await s.commit()
            outsider = Member(
                id=uuid.uuid4(), org_id=seeded["org_id"], type="human",
                user_id=outsider_user_id, name="Outsider",
            )
            s.add(outsider)
            await s.commit()

        await _setup_app_human(app, Session, outsider_user_id, seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/conversations/{seeded['conv_id']}/read", json={},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── list_conversations: N+1 방지 실측(쿼리 수 카운트) ──────────────────────

@pytest.mark.anyio
async def test_list_conversations_unread_count_single_query_not_n_plus_1():
    """대화 3개 각각 unread 메시지가 있어도 unread_count 산출 쿼리는 정확히 1회여야 한다
    (N+1이면 대화 수만큼 증가) — SQLAlchemy 엔진 이벤트로 실행된 SQL 캡처."""
    from app.main import app
    from sqlalchemy import event

    engine, Session = await _session_factory()
    try:
        from app.models.conversation import Conversation, ConversationParticipant
        from app.models.member import Member
        from app.models.organization import Organization
        from app.models.project import Project
        from app.models.project_access import ProjectAccess
        from app.models.user import User

        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
            s.add(project)
            await s.commit()

            user_id = uuid.uuid4()
            s.add(User(id=user_id, email=f"me-{user_id.hex[:8]}@test.com", hashed_password="x"))
            await s.commit()
            me = Member(id=uuid.uuid4(), org_id=org.id, type="human", user_id=user_id, name="Me")
            s.add(me)
            await s.commit()
            s.add(ProjectAccess(
                id=uuid.uuid4(), project_id=project.id, member_id=me.id, permission="granted", role="member",
            ))
            await s.commit()

            other_user_id = uuid.uuid4()
            s.add(User(id=other_user_id, email=f"other-{other_user_id.hex[:8]}@test.com", hashed_password="x"))
            await s.commit()
            other = Member(id=uuid.uuid4(), org_id=org.id, type="human", user_id=other_user_id, name="Other")
            s.add(other)
            await s.commit()
            s.add(ProjectAccess(
                id=uuid.uuid4(), project_id=project.id, member_id=other.id, permission="granted", role="member",
            ))
            await s.commit()

            conv_ids = []
            for i in range(3):
                conv = Conversation(
                    id=uuid.uuid4(), project_id=project.id, org_id=org.id, type="group",
                    title=f"Convo {i}", created_by=me.id,
                )
                s.add(conv)
                await s.flush()
                s.add(ConversationParticipant(conversation_id=conv.id, member_id=me.id))
                s.add(ConversationParticipant(conversation_id=conv.id, member_id=other.id))
                await s.commit()
                await _add_message(s, conv.id, other.id, f"unread in convo {i}", _t(i))
                conv_ids.append(conv.id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)

        # unread_count 산출 쿼리(conversation_participants JOIN conversation_messages ... GROUP BY)
        # 발생 횟수를 센다.
        unread_query_count = 0

        def _before_cursor_execute(conn, cursor, statement, parameters, context, executemany):
            nonlocal unread_query_count
            low = statement.lower()
            if "join conversation_messages" in low and "group by" in low:
                unread_query_count += 1

        event.listen(engine.sync_engine, "before_cursor_execute", _before_cursor_execute)
        try:
            resp = await client.get(
                "/api/v2/conversations", params={"project_id": str(project.id)},
            )
            assert resp.status_code == 200, resp.text
            data = resp.json()["data"]
            assert len(data) == 3
            for item in data:
                assert item["unread_count"] == 1, item
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", _before_cursor_execute)
            await client.aclose()

        assert unread_query_count == 1, f"unread_count 쿼리가 {unread_query_count}회 실행됨(N+1 의심, 대화 3개)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── SSE conversation.read: 본인의 타 커넥션에만(read-receipt 스코프 아웃) ──

@pytest.mark.anyio
async def test_conversation_read_sse_pushed_only_to_self_not_other_participant():
    """본인(sender)의 다른 커넥션 큐에는 conversation.read가 도착하고, 대화 상대방(다른 유저)의
    큐에는 절대 도착하지 않아야 한다(read-receipt 스코프 아웃, §5-1 PO 확定) — 실 큐 실측."""
    import asyncio
    from app.main import app
    import app.routers.events as events_mod

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_conversation(s, n_members=2)
            me, other = seeded["member_ids"]
            await _add_message(s, seeded["conv_id"], other, "msg1", _t(1))

        await _setup_app_human(app, Session, seeded["user_ids"][0], seeded["org_id"])
        client = _client_for(app)

        my_other_tab_queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        other_user_queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        events_mod._agent_connections[str(me)].add(my_other_tab_queue)
        events_mod._agent_connections[str(other)].add(other_user_queue)
        try:
            resp = await client.post(
                f"/api/v2/conversations/{seeded['conv_id']}/read",
                json={"up_to": _t(1).isoformat()},
            )
            assert resp.status_code == 200, resp.text

            # 본인의 다른 탭 큐 — conversation.read 수신 확인.
            received = my_other_tab_queue.get_nowait()
            assert received["event_type"] == "conversation.read"
            assert received["conversation_id"] == str(seeded["conv_id"])
            assert received["member_id"] == str(me)

            # 대화 상대방(other) 큐 — 절대 미수신(read-receipt 스코프 아웃 실측).
            assert other_user_queue.empty(), "read-receipt가 상대방에게 새어나갔다 — 스코프 아웃 위반"
        finally:
            events_mod._agent_connections[str(me)].discard(my_other_tab_queue)
            events_mod._agent_connections[str(other)].discard(other_user_queue)
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
