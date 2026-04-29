"""S16 AC5: Doc router + repository 단위 테스트 (7건 이상)."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
DOC_ID = uuid.uuid4()


def _mock_doc() -> MagicMock:
    d = MagicMock()
    d.id = DOC_ID
    d.org_id = ORG_ID
    d.project_id = PROJECT_ID
    d.parent_id = None
    d.created_by = None
    d.title = "Getting Started"
    d.slug = "getting-started"
    d.content = "# Hello"
    d.icon = None
    d.sort_order = 0
    d.doc_type = "page"
    d.content_format = "markdown"
    d.tags = []
    d.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    d.updated_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    return d


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
async def test_list_docs_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [_mock_doc()]
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/docs?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_doc_201():
    client, session, app = await _client()
    try:
        doc = _mock_doc()
        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = doc

            async with client as c:
                resp = await c.post("/api/v2/docs", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "Getting Started",
                    "slug": "getting-started",
                })

        assert resp.status_code == 201
        assert resp.json()["slug"] == "getting-started"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_doc_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_doc()
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/docs/{DOC_ID}")

        assert resp.status_code == 200
        assert resp.json()["id"] == str(DOC_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_doc_404():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/docs/{uuid.uuid4()}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_doc_200():
    client, session, app = await _client()
    try:
        updated = _mock_doc()
        updated.title = "Updated Title"
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = updated
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.patch(f"/api/v2/docs/{DOC_ID}", json={"title": "Updated Title"})

        assert resp.status_code == 200
        assert resp.json()["title"] == "Updated Title"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_doc_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_doc()
        session.execute = AsyncMock(return_value=mock_result)
        session.delete = AsyncMock()
        session.flush = AsyncMock()

        async with client as c:
            resp = await c.delete(f"/api/v2/docs/{DOC_ID}")

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_docs_with_parent_id_200():
    """트리 구조 — parent_id 필터."""
    client, session, app = await _client()
    try:
        child_doc = _mock_doc()
        child_doc.parent_id = DOC_ID
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [child_doc]
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/docs?project_id={PROJECT_ID}&parent_id={DOC_ID}")

        assert resp.status_code == 200
    finally:
        app.dependency_overrides.clear()
