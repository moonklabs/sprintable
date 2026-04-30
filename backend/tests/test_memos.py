"""S26 AC: Memo router + repository 단위 테스트 (8건 이상)."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
MEMO_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()


def _mock_memo(status: str = "open") -> MagicMock:
    m = MagicMock()
    m.id = MEMO_ID
    m.org_id = ORG_ID
    m.project_id = PROJECT_ID
    m.memo_type = "memo"
    m.title = "Test Memo"
    m.content = "내용"
    m.created_by = MEMBER_ID
    m.assigned_to = None
    m.status = status
    m.supersedes_id = None
    m.resolved_by = None
    m.resolved_at = None
    m.archived_at = None
    m.deleted_at = None
    m.memo_metadata = {}
    m.search_vector = None
    m.created_at = datetime(2026, 4, 30, tzinfo=timezone.utc)
    m.updated_at = datetime(2026, 4, 30, tzinfo=timezone.utc)
    return m


def _mock_reply() -> MagicMock:
    r = MagicMock()
    r.id = uuid.uuid4()
    r.memo_id = MEMO_ID
    r.created_by = MEMBER_ID
    r.content = "답글 내용"
    r.review_type = "comment"
    r.created_at = datetime(2026, 4, 30, tzinfo=timezone.utc)
    return r


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client():
    from app.main import app

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


@pytest.mark.anyio
async def test_list_memos_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.memo.MemoRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = [_mock_memo()]

            async with client as c:
                resp = await c.get(f"/api/v2/memos?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["status"] == "open"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_memos_with_q_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.memo.MemoRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = []

            async with client as c:
                resp = await c.get(f"/api/v2/memos?q=검색어")

        assert resp.status_code == 200
        assert resp.json() == []
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_memo_201():
    client, session, app = await _client()
    try:
        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = _mock_memo()

            async with client as c:
                resp = await c.post("/api/v2/memos", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "content": "내용",
                    "created_by": str(MEMBER_ID),
                })

        assert resp.status_code == 201
        assert resp.json()["memo_type"] == "memo"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_memo_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_memo()
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/memos/{MEMO_ID}")

        assert resp.status_code == 200
        assert resp.json()["id"] == str(MEMO_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_memo_404():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/memos/{uuid.uuid4()}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_soft_delete_memo_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.memo.MemoRepository.soft_delete", new_callable=AsyncMock) as mock_del:
            mock_del.return_value = True

            async with client as c:
                resp = await c.delete(f"/api/v2/memos/{MEMO_ID}")

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_add_reply_201():
    client, session, app = await _client()
    try:
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            result.scalar_one_or_none.return_value = _mock_memo()
            return result

        session.execute = mock_execute

        with patch("app.repositories.memo.MemoReplyRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = _mock_reply()

            async with client as c:
                resp = await c.post(f"/api/v2/memos/{MEMO_ID}/replies", json={
                    "content": "답글 내용",
                    "created_by": str(MEMBER_ID),
                    "review_type": "comment",
                })

        assert resp.status_code == 201
        assert resp.json()["review_type"] == "comment"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_resolve_memo_200():
    client, session, app = await _client()
    try:
        resolved = _mock_memo("resolved")
        with patch("app.repositories.memo.MemoRepository.resolve", new_callable=AsyncMock) as mock_resolve:
            mock_resolve.return_value = resolved

            async with client as c:
                resp = await c.post(f"/api/v2/memos/{MEMO_ID}/resolve?resolved_by={MEMBER_ID}")

        assert resp.status_code == 200
        assert resp.json()["status"] == "resolved"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_archive_memo_200():
    client, session, app = await _client()
    try:
        archived = _mock_memo()
        archived.archived_at = datetime(2026, 4, 30, tzinfo=timezone.utc)
        with patch("app.repositories.memo.MemoRepository.archive", new_callable=AsyncMock) as mock_archive:
            mock_archive.return_value = archived

            async with client as c:
                resp = await c.post(f"/api/v2/memos/{MEMO_ID}/archive")

        assert resp.status_code == 200
    finally:
        app.dependency_overrides.clear()
