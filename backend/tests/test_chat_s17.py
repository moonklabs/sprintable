"""S17 Chat E2E — backend endpoint pytest."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
THREAD_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
SUPABASE_USER_ID = uuid.uuid4()
AGENT_MEMBER_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _mock_memo() -> MagicMock:
    m = MagicMock()
    m.id = THREAD_ID
    m.org_id = ORG_ID
    m.project_id = PROJECT_ID
    m.created_by = MEMBER_ID
    m.assigned_to = AGENT_MEMBER_ID
    m.deleted_at = None
    return m


def _mock_reply(content: str = "테스트 메시지") -> MagicMock:
    r = MagicMock()
    r.id = uuid.uuid4()
    r.memo_id = THREAD_ID
    r.content = content
    r.created_by = MEMBER_ID
    r.review_type = "comment"
    r.attachments = []
    r.created_at = datetime(2026, 5, 14, 1, 0, 0, tzinfo=timezone.utc)
    return r


def _mock_member(member_id: uuid.UUID = MEMBER_ID, member_type: str = "human") -> MagicMock:
    m = MagicMock()
    m.id = member_id
    m.name = "테스트 멤버"
    m.type = member_type
    m.user_id = SUPABASE_USER_ID
    m.org_id = ORG_ID
    return m


def _jwt_auth_ctx():
    ctx = MagicMock()
    ctx.user_id = str(SUPABASE_USER_ID)
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}  # api_key_id 없음 → JWT 경로
    ctx.org_id = str(ORG_ID)
    return ctx


def _api_key_auth_ctx():
    ctx = MagicMock()
    ctx.user_id = str(MEMBER_ID)
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID), "api_key_id": "key-1"}}
    ctx.org_id = str(ORG_ID)
    return ctx


async def _make_client(auth_ctx=None):
    from app.main import app
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db

    if auth_ctx is None:
        auth_ctx = _jwt_auth_ctx()

    mock_session = AsyncMock()
    mock_session.add = MagicMock()
    mock_session.flush = AsyncMock()
    mock_session.commit = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return auth_ctx

    async def override_org_id():
        return ORG_ID

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth
    app.dependency_overrides[get_verified_org_id] = override_org_id

    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


# ─── AC1: POST /api/v2/chats/{thread_id}/messages — JWT 경로 created_by 파생 ────

@pytest.mark.anyio
async def test_send_chat_message_jwt_auth():
    """JWT 경로: created_by를 body 없이 auth context(TeamMember.user_id)에서 파생."""
    client, session, app = await _make_client(_jwt_auth_ctx())
    try:
        mock_memo = _mock_memo()
        mock_reply = _mock_reply("안녕")
        mock_member = _mock_member()

        # session.execute: Memo 조회 → TeamMember(user_id) 조회
        exec_results = [
            MagicMock(scalar_one_or_none=MagicMock(return_value=mock_memo)),  # Memo
            MagicMock(scalar_one_or_none=MagicMock(return_value=mock_member)),  # sender (JWT→user_id)
        ]
        session.execute = AsyncMock(side_effect=exec_results)

        with patch("app.repositories.memo.MemoReplyRepository.create", new_callable=AsyncMock) as mock_create, \
             patch("app.routers.chats._persist_and_push_chat_events", new_callable=AsyncMock):
            mock_create.return_value = mock_reply

            async with client as c:
                resp = await c.post(
                    f"/api/v2/chats/{THREAD_ID}/messages",
                    json={"content": "안녕"},
                    headers={"Authorization": "Bearer jwt-token"},
                )

        assert resp.status_code == 201
        body = resp.json()
        assert "data" in body
        assert body["data"]["content"] == "안녕"
        assert body["data"]["sender"]["id"] == str(MEMBER_ID)
    finally:
        app.dependency_overrides.clear()


# ─── AC2: POST /api/v2/chats/{thread_id}/messages — API key 경로 ────────────

@pytest.mark.anyio
async def test_send_chat_message_api_key_auth():
    """API key 경로: created_by를 auth.user_id(=team_member.id)에서 직접 파생."""
    client, session, app = await _make_client(_api_key_auth_ctx())
    try:
        mock_memo = _mock_memo()
        mock_reply = _mock_reply()
        mock_member = _mock_member()

        exec_results = [
            MagicMock(scalar_one_or_none=MagicMock(return_value=mock_memo)),   # Memo
            MagicMock(scalar_one_or_none=MagicMock(return_value=mock_member)), # sender (api_key→member.id)
        ]
        session.execute = AsyncMock(side_effect=exec_results)

        with patch("app.repositories.memo.MemoReplyRepository.create", new_callable=AsyncMock) as mock_create, \
             patch("app.routers.chats._persist_and_push_chat_events", new_callable=AsyncMock):
            mock_create.return_value = mock_reply

            async with client as c:
                resp = await c.post(
                    f"/api/v2/chats/{THREAD_ID}/messages",
                    json={"content": "에이전트 응답"},
                    headers={"x-agent-api-key": "sk_live_test"},
                )

        assert resp.status_code == 201
        assert "data" in resp.json()
    finally:
        app.dependency_overrides.clear()


# ─── AC3: GET /api/v2/chats/{thread_id}/messages — { data, meta } 래핑 ──────

@pytest.mark.anyio
async def test_list_chat_messages_response_shape():
    """GET 응답이 { data: [...], meta: { next_cursor, has_more } } 형태인지 검증."""
    client, session, app = await _make_client()
    try:
        mock_reply = _mock_reply()
        mock_member = _mock_member()

        exec_results = [
            MagicMock(scalar_one_or_none=MagicMock(return_value=THREAD_ID)),  # Memo 존재 확인
            MagicMock(scalars=MagicMock(return_value=MagicMock(all=MagicMock(return_value=[mock_reply])))),
            MagicMock(scalars=MagicMock(return_value=MagicMock(all=MagicMock(return_value=[mock_member])))),
        ]
        session.execute = AsyncMock(side_effect=exec_results)

        async with client as c:
            resp = await c.get(f"/api/v2/chats/{THREAD_ID}/messages")

        assert resp.status_code == 200
        body = resp.json()
        assert "data" in body
        assert "meta" in body
        assert "next_cursor" in body["meta"]
        assert "has_more" in body["meta"]
    finally:
        app.dependency_overrides.clear()


# ─── AC4: POST upload — created_by form field 없이 auth에서 파생 ─────────────

@pytest.mark.anyio
async def test_send_chat_message_upload_no_created_by_field():
    """upload endpoint: created_by form field 없이 content+file만으로 201 반환."""
    client, session, app = await _make_client(_jwt_auth_ctx())
    try:
        mock_memo = _mock_memo()
        mock_reply = _mock_reply("첨부 메시지")
        mock_member = _mock_member()

        exec_results = [
            MagicMock(scalar_one_or_none=MagicMock(return_value=mock_memo)),
            MagicMock(scalar_one_or_none=MagicMock(return_value=mock_member)),
        ]
        session.execute = AsyncMock(side_effect=exec_results)

        with patch("app.repositories.memo.MemoReplyRepository.create", new_callable=AsyncMock) as mock_create, \
             patch("app.routers.chats._persist_and_push_chat_events", new_callable=AsyncMock):
            mock_create.return_value = mock_reply

            async with client as c:
                resp = await c.post(
                    f"/api/v2/chats/{THREAD_ID}/messages/upload",
                    data={"content": "첨부 메시지"},  # created_by 없음
                    headers={"Authorization": "Bearer jwt-token"},
                )

        assert resp.status_code == 201
        assert "data" in resp.json()
    finally:
        app.dependency_overrides.clear()


# ─── AC5: GET before 커서 페이지네이션 ──────────────────────────────────────

@pytest.mark.anyio
async def test_list_chat_messages_before_cursor():
    """GET ?before= 커서 파라미터 시 has_more + next_cursor 동작 검증."""
    client, session, app = await _make_client()
    try:
        # limit=2, 응답 3개 → has_more=True
        replies = [_mock_reply(f"msg{i}") for i in range(3)]
        mock_member = _mock_member()

        exec_results = [
            MagicMock(scalar_one_or_none=MagicMock(return_value=THREAD_ID)),
            MagicMock(scalars=MagicMock(return_value=MagicMock(all=MagicMock(return_value=replies)))),
            MagicMock(scalars=MagicMock(return_value=MagicMock(all=MagicMock(return_value=[mock_member])))),
        ]
        session.execute = AsyncMock(side_effect=exec_results)

        async with client as c:
            resp = await c.get(
                f"/api/v2/chats/{THREAD_ID}/messages",
                params={"limit": 2, "before": "2026-05-14T01:00:00"},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["meta"]["has_more"] is True
        assert body["meta"]["next_cursor"] is not None
    finally:
        app.dependency_overrides.clear()
