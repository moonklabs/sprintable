"""S18: conftest fixture 기반 통합 테스트 — 각 도메인 헬스 체크."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.mark.anyio
async def test_health_via_conftest(test_client, mock_session):
    """conftest test_client fixture 사용 — health endpoint."""
    mock_session.execute = AsyncMock(return_value=None)
    resp = await test_client.get("/api/v2/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


@pytest.mark.anyio
async def test_sprints_list_via_conftest(test_client, mock_session, org_id):
    """conftest fixture로 sprints list 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get("/api/v2/sprints")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_epics_list_via_conftest(test_client, mock_session):
    """conftest fixture로 epics list 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get("/api/v2/epics")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_tasks_list_via_conftest(test_client, mock_session):
    """conftest fixture로 tasks list 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get("/api/v2/tasks")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_docs_list_via_conftest(test_client, mock_session, project_id):
    """conftest fixture로 docs list 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get(f"/api/v2/docs?project_id={project_id}")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_meetings_list_via_conftest(test_client, mock_session, project_id):
    """conftest fixture로 meetings list 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get(f"/api/v2/meetings?project_id={project_id}")
    assert resp.status_code == 200
    assert resp.json() == []
