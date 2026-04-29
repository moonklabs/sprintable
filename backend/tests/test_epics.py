"""S14 AC5: Epic router + repository 단위 테스트 (7건 이상)."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
EPIC_ID = uuid.uuid4()


def _mock_epic(status: str = "active") -> MagicMock:
    e = MagicMock()
    e.id = EPIC_ID
    e.org_id = ORG_ID
    e.project_id = PROJECT_ID
    e.title = "Epic 1"
    e.status = status
    e.priority = "medium"
    e.description = None
    e.objective = None
    e.success_criteria = None
    e.target_sp = None
    e.target_date = None
    e.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    e.updated_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    return e


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


# ── GET list ──────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_list_epics_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [_mock_epic()]
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get("/api/v2/epics")

        assert resp.status_code == 200
        assert isinstance(resp.json(), list)
    finally:
        app.dependency_overrides.clear()


# ── POST create ───────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_create_epic_201():
    client, session, app = await _client()
    try:
        epic = _mock_epic()
        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = epic

            async with client as c:
                resp = await c.post("/api/v2/epics", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "Epic 1",
                })

        assert resp.status_code == 201
        assert resp.json()["title"] == "Epic 1"
    finally:
        app.dependency_overrides.clear()


# ── GET detail ────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_get_epic_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_epic()
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/epics/{EPIC_ID}")

        assert resp.status_code == 200
        assert resp.json()["id"] == str(EPIC_ID)
    finally:
        app.dependency_overrides.clear()


# ── GET 404 ───────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_get_epic_404():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/epics/{uuid.uuid4()}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


# ── PATCH update ─────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_update_epic_200():
    client, session, app = await _client()
    try:
        updated = _mock_epic("done")
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = updated
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.patch(f"/api/v2/epics/{EPIC_ID}", json={"status": "done"})

        assert resp.status_code == 200
        assert resp.json()["status"] == "done"
    finally:
        app.dependency_overrides.clear()


# ── DELETE ────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_delete_epic_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_epic()
        session.execute = AsyncMock(return_value=mock_result)
        session.delete = AsyncMock()
        session.flush = AsyncMock()

        async with client as c:
            resp = await c.delete(f"/api/v2/epics/{EPIC_ID}")

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
    finally:
        app.dependency_overrides.clear()


# ── GET progress ──────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_get_epic_progress_200():
    client, session, app = await _client()
    try:
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                # get epic
                result.scalar_one_or_none.return_value = _mock_epic()
            else:
                # progress aggregation
                row = MagicMock()
                row.total_stories = 4
                row.done_stories = 2
                row.total_sp = 20
                row.done_sp = 10
                result.one.return_value = row
            return result

        session.execute = mock_execute

        async with client as c:
            resp = await c.get(f"/api/v2/epics/{EPIC_ID}/progress")

        assert resp.status_code == 200
        body = resp.json()
        assert body["total_stories"] == 4
        assert body["done_stories"] == 2
        assert body["completion_pct"] == 50
    finally:
        app.dependency_overrides.clear()
