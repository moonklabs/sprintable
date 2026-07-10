"""S15 AC5: Task router + repository 단위 테스트 (7건 이상)."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

ORG_ID = uuid.uuid4()
STORY_ID = uuid.uuid4()
TASK_ID = uuid.uuid4()


def _mock_task(status: str = "todo") -> MagicMock:
    t = MagicMock()
    t.id = TASK_ID
    t.org_id = ORG_ID
    t.story_id = STORY_ID
    t.assignee_id = None
    t.title = "Task 1"
    t.status = status
    t.story_points = None
    t.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    t.updated_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    return t


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
async def test_list_tasks_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [_mock_task()]
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/tasks?story_id={STORY_ID}")

        assert resp.status_code == 200
        assert isinstance(resp.json(), list)
        assert len(resp.json()) == 1
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_tasks_no_filter_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get("/api/v2/tasks")

        assert resp.status_code == 200
        assert resp.json() == []
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_task_201():
    client, session, app = await _client()
    try:
        task = _mock_task()
        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = task

            async with client as c:
                resp = await c.post("/api/v2/tasks", json={
                    "story_id": str(STORY_ID),
                    "org_id": str(ORG_ID),
                    "title": "Task 1",
                })

        assert resp.status_code == 201
        assert resp.json()["title"] == "Task 1"
        assert resp.json()["status"] == "todo"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_task_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_task()
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/tasks/{TASK_ID}")

        assert resp.status_code == 200
        assert resp.json()["id"] == str(TASK_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_task_404():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/tasks/{uuid.uuid4()}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_task_status_200():
    client, session, app = await _client()
    try:
        updated = _mock_task("done")
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = updated
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.patch(f"/api/v2/tasks/{TASK_ID}", json={"status": "done"})

        assert resp.status_code == 200
        assert resp.json()["status"] == "done"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_task_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_task()
        session.execute = AsyncMock(return_value=mock_result)
        session.delete = AsyncMock()
        session.flush = AsyncMock()

        async with client as c:
            resp = await c.delete(f"/api/v2/tasks/{TASK_ID}")

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_task_404():
    client, session, app = await _client()
    try:
        # E-SECURITY SEC-S1(확장): delete_task가 이제 resolve_member(OrgMember 조회)를 먼저
        # 태우므로, 1번째 execute는 human org_member를 리턴하고 이후(User/task 조회)만 None이어야
        # 의도한 404(존재하지 않는 task)를 재현한다 — 안 그러면 resolve_member 쪽 400이 먼저 뜬다.
        om_mock = MagicMock()
        om_mock.id = uuid.uuid4()
        om_mock.role = "member"
        om_mock.org_id = ORG_ID

        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            result.scalar_one_or_none.return_value = om_mock if call_count == 1 else None
            return result

        session.execute = mock_execute

        async with client as c:
            resp = await c.delete(f"/api/v2/tasks/{uuid.uuid4()}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()
