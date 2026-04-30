"""S36 AC: Agent Runs CRUD 라우터 (7건 이상)."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
AGENT_ID = uuid.uuid4()
RUN_ID = uuid.uuid4()


def _mock_run(status: str = "running") -> MagicMock:
    r = MagicMock()
    r.id = RUN_ID
    r.org_id = ORG_ID
    r.agent_id = AGENT_ID
    r.story_id = None
    r.memo_id = None
    r.trigger = "manual"
    r.model = "claude-opus-4-7"
    r.status = status
    r.result_summary = None
    r.input_tokens = None
    r.output_tokens = None
    r.cost_usd = None
    r.duration_ms = None
    r.last_error_code = None
    r.llm_call_count = 0
    r.run_metadata = {}
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

    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


@pytest.mark.anyio
async def test_list_agent_runs_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_run.AgentRunRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = [_mock_run()]

            async with client as c:
                resp = await c.get(f"/api/v2/agent-runs?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["status"] == "running"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_agent_runs_empty_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_run.AgentRunRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = []

            async with client as c:
                resp = await c.get(f"/api/v2/agent-runs?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        assert resp.json() == []
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_agent_runs_missing_project_id_422():
    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.get("/api/v2/agent-runs")

        assert resp.status_code == 422
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_agent_run_201():
    client, session, app = await _client()
    try:
        mock_member = MagicMock()
        mock_member.scalar_one_or_none.return_value = ORG_ID
        session.execute = AsyncMock(return_value=mock_member)

        with patch("app.repositories.agent_run.AgentRunRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = _mock_run()

            async with client as c:
                resp = await c.post("/api/v2/agent-runs", json={
                    "agent_id": str(AGENT_ID),
                    "trigger": "manual",
                })

        assert resp.status_code == 201
        assert resp.json()["status"] == "running"
        assert resp.json()["trigger"] == "manual"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_agent_run_invalid_agent_400():
    client, session, app = await _client()
    try:
        mock_member = MagicMock()
        mock_member.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_member)

        async with client as c:
            resp = await c.post("/api/v2/agent-runs", json={
                "agent_id": str(uuid.uuid4()),
                "trigger": "manual",
            })

        assert resp.status_code == 400
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_agent_run_completed_200():
    client, session, app = await _client()
    try:
        completed = _mock_run("completed")
        completed.result_summary = "작업 완료"
        completed.input_tokens = 1500
        completed.output_tokens = 300

        with patch("app.repositories.agent_run.AgentRunRepository.update", new_callable=AsyncMock) as mock_update:
            mock_update.return_value = completed

            async with client as c:
                resp = await c.patch(f"/api/v2/agent-runs/{RUN_ID}", json={
                    "status": "completed",
                    "result_summary": "작업 완료",
                    "input_tokens": 1500,
                    "output_tokens": 300,
                })

        assert resp.status_code == 200
        assert resp.json()["status"] == "completed"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_agent_run_failed_200():
    client, session, app = await _client()
    try:
        failed = _mock_run("failed")
        failed.last_error_code = "timeout"

        with patch("app.repositories.agent_run.AgentRunRepository.update", new_callable=AsyncMock) as mock_update:
            mock_update.return_value = failed

            async with client as c:
                resp = await c.patch(f"/api/v2/agent-runs/{RUN_ID}", json={
                    "status": "failed",
                    "last_error_code": "timeout",
                })

        assert resp.status_code == 200
        assert resp.json()["status"] == "failed"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_agent_run_404():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_run.AgentRunRepository.update", new_callable=AsyncMock) as mock_update:
            mock_update.return_value = None

            async with client as c:
                resp = await c.patch(f"/api/v2/agent-runs/{uuid.uuid4()}", json={"status": "completed"})

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()
