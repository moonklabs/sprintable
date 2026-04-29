"""S19 AC5: Story router + repository 단위 테스트."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
STORY_ID = uuid.uuid4()


def _mock_story(status: str = "backlog") -> MagicMock:
    s = MagicMock()
    s.id = STORY_ID
    s.org_id = ORG_ID
    s.project_id = PROJECT_ID
    s.epic_id = None
    s.sprint_id = None
    s.assignee_id = None
    s.meeting_id = None
    s.title = "Story 1"
    s.status = status
    s.priority = "medium"
    s.story_points = 3
    s.description = None
    s.acceptance_criteria = None
    s.position = None
    s.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    s.updated_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    return s


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
async def test_list_stories_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [_mock_story()]
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/stories?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["status"] == "backlog"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_story_201():
    client, session, app = await _client()
    try:
        story = _mock_story()
        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = story

            async with client as c:
                resp = await c.post("/api/v2/stories", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "Story 1",
                    "story_points": 3,
                })

        assert resp.status_code == 201
        assert resp.json()["story_points"] == 3
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_story_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_story()
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/stories/{STORY_ID}")

        assert resp.status_code == 200
        assert resp.json()["id"] == str(STORY_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_story_404():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/stories/{uuid.uuid4()}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_story_200():
    client, session, app = await _client()
    try:
        updated = _mock_story()
        updated.story_points = 5
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = updated
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.patch(f"/api/v2/stories/{STORY_ID}", json={"story_points": 5})

        assert resp.status_code == 200
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_story_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_story()
        session.execute = AsyncMock(return_value=mock_result)
        session.delete = AsyncMock()
        session.flush = AsyncMock()

        async with client as c:
            resp = await c.delete(f"/api/v2/stories/{STORY_ID}")

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_status_transition_200():
    """backlog → ready-for-dev 순차 전이 성공."""
    client, session, app = await _client()
    try:
        backlog_story = _mock_story("backlog")
        ready_story = _mock_story("ready-for-dev")

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = backlog_story
            else:
                result.scalar_one_or_none.return_value = ready_story
            return result

        session.execute = mock_execute

        async with client as c:
            resp = await c.patch(
                f"/api/v2/stories/{STORY_ID}/status",
                json={"status": "ready-for-dev"},
            )

        assert resp.status_code == 200
        assert resp.json()["status"] == "ready-for-dev"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_status_transition_invalid_400():
    """backlog → done 비순차 전이 → 400."""
    client, session, app = await _client()
    try:
        backlog_story = _mock_story("backlog")
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = backlog_story
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.patch(
                f"/api/v2/stories/{STORY_ID}/status",
                json={"status": "done"},
            )

        assert resp.status_code == 400
    finally:
        app.dependency_overrides.clear()
