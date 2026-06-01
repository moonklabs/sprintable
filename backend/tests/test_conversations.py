"""S37: conversations 테이블 + Chat API 전환 테스트."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient


ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
CONV_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _make_member(member_id: uuid.UUID = MEMBER_ID, member_type: str = "human") -> MagicMock:
    m = MagicMock()
    m.id = member_id
    m.name = "테스트 멤버"
    m.type = member_type
    m.org_id = ORG_ID
    m.user_id = uuid.uuid4()
    return m


def _make_conv(conv_id: uuid.UUID = CONV_ID, conv_type: str = "group") -> MagicMock:
    c = MagicMock()
    c.id = conv_id
    c.org_id = ORG_ID
    c.project_id = PROJECT_ID
    c.type = conv_type
    c.title = "테스트 대화"
    c.created_by = MEMBER_ID
    c.updated_at = datetime(2026, 5, 14, tzinfo=timezone.utc)
    return c


def _make_msg(msg_id: uuid.UUID | None = None) -> MagicMock:
    m = MagicMock()
    m.id = msg_id or uuid.uuid4()
    m.conversation_id = CONV_ID
    m.sender_id = MEMBER_ID
    m.content = "테스트 메시지"
    m.mentioned_ids = []
    m.created_at = datetime(2026, 5, 14, 12, 0, tzinfo=timezone.utc)
    m.updated_at = datetime(2026, 5, 14, 12, 0, tzinfo=timezone.utc)
    return m




@pytest.fixture(autouse=True)
def _skip_agent_policy(monkeypatch):
    """기존 conversations 테스트는 에이전트 인가 불변식을 별도 테스트에서 검증 — 여기서 skip."""
    async def _noop(*args, **kwargs):
        pass
    monkeypatch.setattr("app.routers.conversations._enforce_agent_creator_policy", _noop)

async def _make_client(session=None):
    from app.main import app
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db

    if session is None:
        session = AsyncMock()
        session.add = MagicMock()
        session.flush = AsyncMock()
        session.commit = AsyncMock()
        session.refresh = AsyncMock()
        nested_cm = AsyncMock()
        nested_cm.__aenter__ = AsyncMock(return_value=None)
        nested_cm.__aexit__ = AsyncMock(return_value=False)
        session.begin_nested = MagicMock(return_value=nested_cm)

    ctx = MagicMock()
    ctx.user_id = str(MEMBER_ID)
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    async def _db():
        yield session

    async def _auth():
        return ctx

    async def _org():
        return ORG_ID

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), session, app


# ─── AC1: Alembic migration 파일 + 테이블 확인 ───────────────────────────────

def test_migration_file_exists():
    """0030_add_conversations.py migration 존재 확인."""
    import os
    path = os.path.join(os.path.dirname(__file__), "..", "alembic", "versions", "0030_add_conversations.py")
    assert os.path.exists(path)


def test_migration_has_correct_tables():
    """migration에 3개 테이블 정의 확인."""
    import os
    path = os.path.join(os.path.dirname(__file__), "..", "alembic", "versions", "0030_add_conversations.py")
    src = open(path).read()
    for tbl in ("conversations", "conversation_participants", "conversation_messages"):
        assert tbl in src, f"{tbl} 없음"


# ─── AC2: 모델 임포트 확인 ───────────────────────────────────────────────────

def test_models_importable():
    """conversation 모델 임포트 가능 확인."""
    from app.models.conversation import Conversation, ConversationParticipant, ConversationMessage
    assert Conversation.__tablename__ == "conversations"
    assert ConversationParticipant.__tablename__ == "conversation_participants"
    assert ConversationMessage.__tablename__ == "conversation_messages"


# ─── AC3: POST /conversations — group 생성 ──────────────────────────────────

@pytest.mark.anyio
async def test_create_group_conversation():
    """POST /api/v2/conversations — group 대화 생성 201."""
    client, session, app = await _make_client()
    try:
        mock_member = _make_member()

        member_result = MagicMock()
        member_result.scalars.return_value.first.return_value = mock_member
        session.execute = AsyncMock(return_value=member_result)

        async def _refresh(obj):
            obj.id = CONV_ID
            obj.type = "group"
            obj.title = "테스트"

        session.refresh.side_effect = _refresh

        async with client as c:
            resp = await c.post("/api/v2/conversations", json={
                "type": "group",
                "title": "테스트",
                "participant_ids": [str(uuid.uuid4())],
                "project_id": str(PROJECT_ID),
            })

        assert resp.status_code == 201
        body = resp.json()
        assert "id" in body
        assert body["type"] == "group"
        assert body["existing"] is False
    finally:
        app.dependency_overrides.clear()


# ─── AC4: POST /conversations — DM 중복 방지 ────────────────────────────────

@pytest.mark.anyio
async def test_create_dm_deduplication():
    """dm 중복 시 기존 conversation 반환 + existing=True."""
    client, session, app = await _make_client()
    try:
        mock_member = _make_member()
        other_id = uuid.uuid4()

        member_result = MagicMock()
        member_result.scalars.return_value.first.return_value = mock_member

        existing_dm_result = MagicMock()
        existing_dm_result.scalars.return_value.all.return_value = [CONV_ID]

        other_check_result = MagicMock()
        other_check_result.scalar_one_or_none.return_value = uuid.uuid4()  # 있음

        session.execute = AsyncMock(side_effect=[member_result, existing_dm_result, other_check_result])

        async with client as c:
            resp = await c.post("/api/v2/conversations", json={
                "type": "dm",
                "participant_ids": [str(other_id)],
                "project_id": str(PROJECT_ID),
            })

        assert resp.status_code == 201
        body = resp.json()
        assert body["existing"] is True
        assert body["id"] == str(CONV_ID)
    finally:
        app.dependency_overrides.clear()


# ─── AC5: GET /conversations — 목록 ─────────────────────────────────────────

@pytest.mark.anyio
async def test_list_conversations():
    """GET /api/v2/conversations → data 배열 반환."""
    client, session, app = await _make_client()
    try:
        mock_member = _make_member()
        mock_conv = _make_conv()
        mock_msg = _make_msg()

        member_result = MagicMock()
        member_result.scalars.return_value.first.return_value = mock_member

        conv_ids_result = MagicMock()
        conv_ids_result.all.return_value = [(CONV_ID,)]

        total_result = MagicMock()
        total_result.scalar_one.return_value = 1

        convs_result = MagicMock()
        convs_result.scalars.return_value.all.return_value = [mock_conv]

        p_rows_result = MagicMock()
        p_rows_result.all.return_value = []

        latest_msg_result = MagicMock()
        latest_msg_result.scalar_one_or_none.return_value = mock_msg

        session.execute = AsyncMock(side_effect=[
            member_result, conv_ids_result, total_result,
            convs_result, p_rows_result, latest_msg_result,
        ])

        async with client as c:
            resp = await c.get(f"/api/v2/conversations?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        body = resp.json()
        assert "data" in body
        assert len(body["data"]) == 1
        assert body["data"][0]["id"] == str(CONV_ID)
        assert body["data"][0]["latest_message"]["content"] == "테스트 메시지"
    finally:
        app.dependency_overrides.clear()


# ─── AC6: GET /conversations/{id}/messages — cursor 페이지네이션 ─────────────

@pytest.mark.anyio
async def test_list_messages_response_shape():
    """GET /conversations/{id}/messages → { data, meta } 반환."""
    client, session, app = await _make_client()
    try:
        mock_member = _make_member()
        mock_member.role = "owner"  # skip participant check branch
        mock_msg = _make_msg()

        conv_project_result = MagicMock()
        conv_project_result.scalar_one_or_none.return_value = PROJECT_ID

        member_result = MagicMock()
        member_result.scalars.return_value.first.return_value = mock_member

        msgs_result = MagicMock()
        msgs_result.scalars.return_value.all.return_value = [mock_msg]

        sender_result = MagicMock()
        sender_result.scalars.return_value.all.return_value = [mock_member]

        session.execute = AsyncMock(side_effect=[conv_project_result, member_result, msgs_result, sender_result])

        async with client as c:
            resp = await c.get(f"/api/v2/conversations/{CONV_ID}/messages")

        assert resp.status_code == 200
        body = resp.json()
        assert "data" in body
        assert "meta" in body
        assert "next_cursor" in body["meta"]
        assert "has_more" in body["meta"]
    finally:
        app.dependency_overrides.clear()


# ─── AC7: POST /conversations/{id}/messages — 전송 ──────────────────────────

@pytest.mark.anyio
async def test_send_message_201():
    """POST /conversations/{id}/messages → 201 + data."""
    client, session, app = await _make_client()
    try:
        mock_member = _make_member()
        mock_conv = _make_conv()
        mock_msg = _make_msg()

        member_result = MagicMock()
        member_result.scalars.return_value.first.return_value = mock_member

        conv_result = MagicMock()
        conv_result.scalar_one_or_none.return_value = mock_conv

        participant_result = MagicMock()
        participant_result.scalar_one_or_none.return_value = uuid.uuid4()

        session.execute = AsyncMock(side_effect=[member_result, conv_result, participant_result])

        async def _refresh(obj):
            obj.id = mock_msg.id
            obj.conversation_id = CONV_ID
            obj.sender_id = MEMBER_ID
            obj.content = "안녕"
            obj.mentioned_ids = []
            obj.created_at = datetime(2026, 5, 14, 12, 0, tzinfo=timezone.utc)

        session.refresh.side_effect = _refresh

        with patch("app.routers.conversations._dispatch_conversation_event", new_callable=AsyncMock):
            async with client as c:
                resp = await c.post(f"/api/v2/conversations/{CONV_ID}/messages", json={"content": "안녕"})

        assert resp.status_code == 201
        body = resp.json()
        assert "data" in body
        assert body["data"]["content"] == "안녕"
    finally:
        app.dependency_overrides.clear()


# ─── AC8: 비참여자 메시지 전송 → 403 ─────────────────────────────────────────

@pytest.mark.anyio
async def test_send_message_403_non_participant():
    """비참여자 POST /messages → 403."""
    client, session, app = await _make_client()
    try:
        mock_member = _make_member()
        mock_conv = _make_conv()

        member_result = MagicMock()
        member_result.scalars.return_value.first.return_value = mock_member

        conv_result = MagicMock()
        conv_result.scalar_one_or_none.return_value = mock_conv

        participant_result = MagicMock()
        participant_result.scalar_one_or_none.return_value = None  # 비참여자

        session.execute = AsyncMock(side_effect=[member_result, conv_result, participant_result])

        async with client as c:
            resp = await c.post(f"/api/v2/conversations/{CONV_ID}/messages", json={"content": "테스트"})

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()
