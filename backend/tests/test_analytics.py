"""S28 AC: Analytics 라우터 단위 테스트 (8건 이상)."""
import uuid
from datetime import date, datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
SPRINT_ID = uuid.uuid4()
EPIC_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
AGENT_ID = uuid.uuid4()


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

    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


@pytest.mark.anyio
async def test_get_overview_200():
    client, session, app = await _client()
    try:
        mock_data = {
            "sprints": {"total": 5, "active": 1},
            "epics": 3,
            "stories": {"total": 20, "done": 8, "total_points": 100},
            "tasks": 15,
            "memos": {"total": 7, "open": 3},
            "members": {"total": 4, "humans": 2, "agents": 2},
        }
        with patch("app.repositories.analytics.AnalyticsRepository.get_overview", new_callable=AsyncMock) as mock_fn:
            mock_fn.return_value = mock_data

            async with client as c:
                resp = await c.get(f"/api/v2/analytics/overview?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        data = resp.json()
        assert data["epics"] == 3
        assert data["sprints"]["active"] == 1
        assert data["members"]["agents"] == 2
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_member_workload_200():
    client, session, app = await _client()
    try:
        mock_data = {
            "stories": {"total": 3, "in_progress": 1, "points": 13},
            "tasks": {"total": 5, "in_progress": 2},
        }
        with patch("app.repositories.analytics.AnalyticsRepository.get_member_workload", new_callable=AsyncMock) as mock_fn:
            mock_fn.return_value = mock_data

            async with client as c:
                resp = await c.get(f"/api/v2/analytics/workload?project_id={PROJECT_ID}&member_id={MEMBER_ID}")

        assert resp.status_code == 200
        assert resp.json()["stories"]["total"] == 3
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_velocity_history_200():
    client, session, app = await _client()
    try:
        mock_data = [
            {"id": SPRINT_ID, "title": "Sprint 1", "velocity": 30, "status": "closed",
             "start_date": date(2026, 4, 1), "end_date": date(2026, 4, 14)},
        ]
        with patch("app.repositories.analytics.AnalyticsRepository.get_velocity_history", new_callable=AsyncMock) as mock_fn:
            mock_fn.return_value = mock_data

            async with client as c:
                resp = await c.get(f"/api/v2/analytics/velocity-history?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["velocity"] == 30
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_recent_activity_200():
    client, session, app = await _client()
    try:
        mock_data = {
            "recent_stories": [{"id": str(uuid.uuid4()), "title": "Story A", "status": "in-progress", "updated_at": "2026-04-30T00:00:00+00:00"}],
            "recent_memos": [],
            "recent_agent_runs": [],
        }
        with patch("app.repositories.analytics.AnalyticsRepository.get_recent_activity", new_callable=AsyncMock) as mock_fn:
            mock_fn.return_value = mock_data

            async with client as c:
                resp = await c.get(f"/api/v2/analytics/activity?project_id={PROJECT_ID}&limit=5")

        assert resp.status_code == 200
        assert len(resp.json()["recent_stories"]) == 1
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_epic_progress_200():
    client, session, app = await _client()
    try:
        mock_data = {
            "total_stories": 10,
            "done_stories": 4,
            "total_points": 50,
            "done_points": 20,
            "completion_pct": 40,
        }
        with patch("app.repositories.analytics.AnalyticsRepository.get_epic_progress", new_callable=AsyncMock) as mock_fn:
            mock_fn.return_value = mock_data

            async with client as c:
                resp = await c.get(f"/api/v2/analytics/epic-progress?project_id={PROJECT_ID}&epic_id={EPIC_ID}")

        assert resp.status_code == 200
        assert resp.json()["completion_pct"] == 40
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_agent_stats_200():
    client, session, app = await _client()
    try:
        mock_data = {
            "total_runs": 100,
            "completed": 90,
            "failed": 10,
            "total_tokens": 50000,
            "total_cost_usd": 1.5,
            "avg_duration_ms": 3200,
        }
        with patch("app.repositories.analytics.AnalyticsRepository.get_agent_stats", new_callable=AsyncMock) as mock_fn:
            mock_fn.return_value = mock_data

            async with client as c:
                resp = await c.get(f"/api/v2/analytics/agent-stats?project_id={PROJECT_ID}&agent_id={AGENT_ID}")

        assert resp.status_code == 200
        assert resp.json()["completed"] == 90
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_agent_stats_404():
    client, session, app = await _client()
    try:
        with patch("app.repositories.analytics.AnalyticsRepository.get_agent_stats", new_callable=AsyncMock) as mock_fn:
            mock_fn.return_value = None

            async with client as c:
                resp = await c.get(f"/api/v2/analytics/agent-stats?project_id={PROJECT_ID}&agent_id={AGENT_ID}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_project_health_200():
    client, session, app = await _client()
    try:
        mock_data = {
            "active_sprint": {"id": SPRINT_ID, "title": "Sprint 5", "start_date": date(2026, 4, 28), "end_date": date(2026, 5, 11)},
            "sprint_progress": 25,
            "open_memos": 2,
            "unassigned_stories": 1,
            "health": "good",
        }
        with patch("app.repositories.analytics.AnalyticsRepository.get_project_health", new_callable=AsyncMock) as mock_fn:
            mock_fn.return_value = mock_data

            async with client as c:
                resp = await c.get(f"/api/v2/analytics/health?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        assert resp.json()["health"] == "good"
        assert resp.json()["sprint_progress"] == 25
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_burndown_200():
    client, session, app = await _client()
    try:
        mock_data = {
            "sprint": {
                "id": SPRINT_ID, "title": "Sprint 5", "status": "active",
                "start_date": date(2026, 4, 28), "end_date": date(2026, 5, 11),
                "duration": 14, "velocity": None,
            },
            "total_points": 40,
            "done_points": 10,
            "remaining_points": 30,
            "completion_pct": 25,
            "stories_count": 8,
            "done_count": 2,
            "ideal_line": [{"date": "2026-04-28", "points": 40}],
            "actual_line": [{"date": "2026-04-28", "points": 40}, {"date": "2026-04-30", "points": 30}],
        }
        with patch("app.repositories.analytics.AnalyticsRepository.get_burndown", new_callable=AsyncMock) as mock_fn:
            mock_fn.return_value = mock_data

            async with client as c:
                resp = await c.get(f"/api/v2/sprints/{SPRINT_ID}/burndown")

        assert resp.status_code == 200
        assert resp.json()["remaining_points"] == 30
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_burndown_404():
    client, session, app = await _client()
    try:
        with patch("app.repositories.analytics.AnalyticsRepository.get_burndown", new_callable=AsyncMock) as mock_fn:
            mock_fn.return_value = None

            async with client as c:
                resp = await c.get(f"/api/v2/sprints/{uuid.uuid4()}/burndown")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_sprint_velocity_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.analytics.AnalyticsRepository.get_sprint_velocity", new_callable=AsyncMock) as mock_fn:
            mock_fn.return_value = {"velocity": 35, "title": "Sprint 5", "status": "active"}

            async with client as c:
                resp = await c.get(f"/api/v2/sprints/{SPRINT_ID}/velocity")

        assert resp.status_code == 200
        assert resp.json()["velocity"] == 35
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_leaderboard_200():
    client, session, app = await _client()
    try:
        mock_data = [
            {"member_id": MEMBER_ID, "balance": 150.0},
            {"member_id": AGENT_ID, "balance": 80.0},
        ]
        with patch("app.repositories.analytics.AnalyticsRepository.get_leaderboard", new_callable=AsyncMock) as mock_fn:
            mock_fn.return_value = mock_data

            async with client as c:
                resp = await c.get(f"/api/v2/rewards/leaderboard?project_id={PROJECT_ID}&period=all")

        assert resp.status_code == 200
        assert len(resp.json()) == 2
        assert resp.json()[0]["balance"] == 150.0
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_leaderboard_invalid_period_400():
    client, session, app = await _client()
    try:
        with patch("app.repositories.analytics.AnalyticsRepository.get_leaderboard", new_callable=AsyncMock):
            async with client as c:
                resp = await c.get(f"/api/v2/rewards/leaderboard?project_id={PROJECT_ID}&period=invalid")

        assert resp.status_code == 400
    finally:
        app.dependency_overrides.clear()
