"""S24 AC: Retro router + repository 단위 테스트 (7건 이상)."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
SESSION_ID = uuid.uuid4()
ITEM_ID = uuid.uuid4()
VOTER_ID = uuid.uuid4()


def _mock_session(phase: str = "collect") -> MagicMock:
    s = MagicMock()
    s.id = SESSION_ID
    s.org_id = ORG_ID
    s.project_id = PROJECT_ID
    s.sprint_id = None
    s.created_by = None
    s.title = "Sprint 3 Retro"
    s.phase = phase
    s.items = []
    s.actions = []
    s.created_at = datetime(2026, 4, 29, tzinfo=timezone.utc)
    s.updated_at = datetime(2026, 4, 29, tzinfo=timezone.utc)
    return s


def _mock_item() -> MagicMock:
    i = MagicMock()
    i.id = ITEM_ID
    i.session_id = SESSION_ID
    i.author_id = None
    i.category = "good"
    i.text = "팀워크 좋았는"
    i.vote_count = 2
    i.created_at = datetime(2026, 4, 29, tzinfo=timezone.utc)
    return i


def _mock_action() -> MagicMock:
    a = MagicMock()
    a.id = uuid.uuid4()
    a.session_id = SESSION_ID
    a.assignee_id = None
    a.title = "CI 속도 개선"
    a.status = "open"
    a.created_at = datetime(2026, 4, 29, tzinfo=timezone.utc)
    return a


def _mock_vote() -> MagicMock:
    v = MagicMock()
    v.id = uuid.uuid4()
    v.item_id = ITEM_ID
    v.voter_id = VOTER_ID
    v.created_at = datetime(2026, 4, 29, tzinfo=timezone.utc)
    return v


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
async def test_list_retro_sessions_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [_mock_session()]
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/retros?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["phase"] == "collect"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_retro_session_201():
    client, session, app = await _client()
    try:
        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = _mock_session()

            async with client as c:
                resp = await c.post("/api/v2/retros", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "Sprint 3 Retro",
                })

        assert resp.status_code == 201
        assert resp.json()["title"] == "Sprint 3 Retro"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_retro_session_with_items_200():
    """GET /{id} → items + actions nested."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session()
        mock_result.scalars.return_value.all.return_value = []
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/retros/{SESSION_ID}")

        assert resp.status_code == 200
        body = resp.json()
        assert body["id"] == str(SESSION_ID)
        assert "items" in body
        assert "actions" in body
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_retro_session_404():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/retros/{uuid.uuid4()}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_advance_phase_200():
    """collect → group 순차 전이."""
    client, session, app = await _client()
    try:
        collect_session = _mock_session("collect")
        group_session = _mock_session("group")

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = collect_session
            else:
                result.scalar_one_or_none.return_value = group_session
            return result

        session.execute = mock_execute

        async with client as c:
            resp = await c.patch(f"/api/v2/retros/{SESSION_ID}/phase", json={"phase": "group"})

        assert resp.status_code == 200
        assert resp.json()["phase"] == "group"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_add_item_201():
    client, session, app = await _client()
    try:
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            result.scalar_one_or_none.return_value = _mock_session() if call_count == 1 else _mock_item()
            return result

        session.execute = mock_execute
        session.flush = AsyncMock()
        session.refresh = AsyncMock()
        session.add = MagicMock()

        with patch("app.repositories.retro.RetroItemRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = _mock_item()

            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/items", json={
                    "category": "good",
                    "text": "팀워크 좋았는",
                })

        assert resp.status_code == 201
        assert resp.json()["category"] == "good"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_vote_duplicate_409():
    """중복 투표 → 409."""
    client, session, app = await _client()
    try:
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = _mock_session()
            else:
                result.scalar_one_or_none.return_value = _mock_vote()  # 이미 존재
            return result

        session.execute = mock_execute

        async with client as c:
            resp = await c.post(
                f"/api/v2/retros/{SESSION_ID}/items/{ITEM_ID}/vote?voter_id={VOTER_ID}"
            )

        assert resp.status_code == 409
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_export_markdown_200():
    client, session, app = await _client()
    try:
        retro_session = _mock_session("closed")
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = retro_session
            else:
                result.scalars.return_value.all.return_value = []
            return result

        session.execute = mock_execute

        async with client as c:
            resp = await c.get(f"/api/v2/retros/{SESSION_ID}/export")

        assert resp.status_code == 200
        assert "Sprint 3 Retro" in resp.text
        assert "# " in resp.text
    finally:
        app.dependency_overrides.clear()
