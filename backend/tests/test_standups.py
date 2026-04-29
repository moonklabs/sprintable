"""S23 AC: Standup router + repository 단위 테스트 (7건 이상)."""
import uuid
from datetime import date, datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
AUTHOR_ID = uuid.uuid4()
ENTRY_ID = uuid.uuid4()
TODAY = date(2026, 4, 29)


def _mock_entry() -> MagicMock:
    e = MagicMock()
    e.id = ENTRY_ID
    e.org_id = ORG_ID
    e.project_id = PROJECT_ID
    e.sprint_id = None
    e.author_id = AUTHOR_ID
    e.date = TODAY
    e.done = "S19 완료"
    e.plan = "S20 착수"
    e.blockers = None
    e.plan_story_ids = []
    e.created_at = datetime(2026, 4, 29, tzinfo=timezone.utc)
    e.updated_at = datetime(2026, 4, 29, tzinfo=timezone.utc)
    return e


def _mock_feedback() -> MagicMock:
    f = MagicMock()
    f.id = uuid.uuid4()
    f.org_id = ORG_ID
    f.project_id = PROJECT_ID
    f.sprint_id = None
    f.standup_entry_id = ENTRY_ID
    f.feedback_by_id = uuid.uuid4()
    f.review_type = "approve"
    f.feedback_text = "LGTM"
    f.created_at = datetime(2026, 4, 29, tzinfo=timezone.utc)
    f.updated_at = datetime(2026, 4, 29, tzinfo=timezone.utc)
    return f


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
async def test_list_standups_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [_mock_entry()]
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/standups?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_upsert_standup_insert_201():
    """신규 스탠드업 upsert → INSERT."""
    client, session, app = await _client()
    try:
        entry = _mock_entry()
        with patch("app.repositories.standup.StandupEntryRepository.upsert", new_callable=AsyncMock) as mock_upsert:
            mock_upsert.return_value = entry

            async with client as c:
                resp = await c.post("/api/v2/standups", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "author_id": str(AUTHOR_ID),
                    "date": str(TODAY),
                    "done": "S19 완료",
                    "plan": "S20 착수",
                })

        assert resp.status_code == 201
        assert resp.json()["done"] == "S19 완료"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_standup_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_entry()
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/standups/{ENTRY_ID}")

        assert resp.status_code == 200
        assert resp.json()["id"] == str(ENTRY_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_standup_404():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/standups/{uuid.uuid4()}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_missing_standups_200():
    """GET /standups/missing — 미제출 멤버 UUID 목록."""
    client, session, app = await _client()
    try:
        missing_id = uuid.uuid4()
        with patch("app.repositories.standup.StandupEntryRepository.get_missing", new_callable=AsyncMock) as mock_missing:
            mock_missing.return_value = [missing_id]

            async with client as c:
                resp = await c.get(f"/api/v2/standups/missing?project_id={PROJECT_ID}&date={TODAY}")

        assert resp.status_code == 200
        assert str(missing_id) in resp.json()
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_add_feedback_201():
    client, session, app = await _client()
    try:
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            result.scalar_one_or_none.return_value = _mock_entry()
            result.scalars.return_value.all.return_value = []
            return result

        session.execute = mock_execute

        fb = _mock_feedback()
        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = fb

            async with client as c:
                resp = await c.post(f"/api/v2/standups/{ENTRY_ID}/feedback", json={
                    "org_id": str(ORG_ID),
                    "project_id": str(PROJECT_ID),
                    "feedback_by_id": str(uuid.uuid4()),
                    "review_type": "approve",
                    "feedback_text": "LGTM",
                })

        assert resp.status_code == 201
        assert resp.json()["review_type"] == "approve"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_add_feedback_invalid_type_400():
    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.post(f"/api/v2/standups/{ENTRY_ID}/feedback", json={
                "org_id": str(ORG_ID),
                "project_id": str(PROJECT_ID),
                "feedback_by_id": str(uuid.uuid4()),
                "review_type": "invalid",
                "feedback_text": "text",
            })

        assert resp.status_code == 400
    finally:
        app.dependency_overrides.clear()
