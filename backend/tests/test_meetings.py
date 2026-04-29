"""S17 AC5: Meeting router + repository 단위 테스트 (5건 이상)."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

PROJECT_ID = uuid.uuid4()
MEETING_ID = uuid.uuid4()


def _mock_meeting(meeting_type: str = "general") -> MagicMock:
    m = MagicMock()
    m.id = MEETING_ID
    m.project_id = PROJECT_ID
    m.created_by = None
    m.title = "Sprint Review"
    m.meeting_type = meeting_type
    m.date = datetime(2026, 5, 1, 10, 0, tzinfo=timezone.utc)
    m.duration_min = 60
    m.participants = []
    m.raw_transcript = None
    m.ai_summary = None
    m.decisions = []
    m.action_items = []
    m.deleted_at = None
    m.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    m.updated_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    return m


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client():
    from app.main import app

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {}

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
async def test_list_meetings_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [_mock_meeting()]
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/meetings?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
        assert len(data) == 1
        assert data[0]["meeting_type"] == "general"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_meeting_201():
    client, session, app = await _client()
    try:
        meeting = _mock_meeting()
        session.add = MagicMock()
        session.flush = AsyncMock()
        session.refresh = AsyncMock()

        with patch("app.repositories.meeting.MeetingRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = meeting

            async with client as c:
                resp = await c.post("/api/v2/meetings", json={
                    "project_id": str(PROJECT_ID),
                    "title": "Sprint Review",
                    "meeting_type": "review",
                })

        assert resp.status_code == 201
        assert resp.json()["title"] == "Sprint Review"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_meeting_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_meeting()
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/meetings/{MEETING_ID}?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        assert resp.json()["id"] == str(MEETING_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_meeting_404():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/meetings/{uuid.uuid4()}?project_id={PROJECT_ID}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_meeting_200():
    client, session, app = await _client()
    try:
        updated = _mock_meeting()
        updated.ai_summary = "Updated summary"
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = updated
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.patch(
                f"/api/v2/meetings/{MEETING_ID}?project_id={PROJECT_ID}",
                json={"ai_summary": "Updated summary"},
            )

        assert resp.status_code == 200
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_meeting_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_meeting()
        session.execute = AsyncMock(return_value=mock_result)
        session.delete = AsyncMock()
        session.flush = AsyncMock()

        async with client as c:
            resp = await c.delete(f"/api/v2/meetings/{MEETING_ID}?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
    finally:
        app.dependency_overrides.clear()
