"""S20 AC5: Project router + repository 단위 테스트."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()


def _mock_project(name: str = "Sprintable") -> MagicMock:
    p = MagicMock()
    p.id = PROJECT_ID
    p.org_id = ORG_ID
    p.name = name
    p.description = None
    p.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    p.updated_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    return p


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
async def test_list_projects_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [_mock_project()]
        session.execute = AsyncMock(return_value=mock_result)

        # 정책B: list_projects가 accessible_project_ids_in_org로 필터 → 접근 가능 id 주입
        with patch(
            "app.routers.projects.accessible_project_ids_in_org",
            new=AsyncMock(return_value=[PROJECT_ID]),
        ):
            async with client as c:
                resp = await c.get("/api/v2/projects")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_projects_empty_when_no_access():
    """정책B: 접근 가능 프로젝트 0개면 빈 목록(과노출 차단)."""
    client, session, app = await _client()
    try:
        with patch(
            "app.routers.projects.accessible_project_ids_in_org",
            new=AsyncMock(return_value=[]),
        ):
            async with client as c:
                resp = await c.get("/api/v2/projects")
        assert resp.status_code == 200
        assert resp.json() == []
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_project_201():
    client, session, app = await _client()
    try:
        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create, \
                patch("app.routers.projects.ensure_human_member", new_callable=AsyncMock):
            mock_create.return_value = _mock_project()

            async with client as c:
                resp = await c.post("/api/v2/projects", json={
                    "org_id": str(ORG_ID),
                    "name": "Sprintable",
                })

        assert resp.status_code == 201
        assert resp.json()["name"] == "Sprintable"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_project_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_project()
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/projects/{PROJECT_ID}")

        assert resp.status_code == 200
        assert resp.json()["id"] == str(PROJECT_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_project_404():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/projects/{uuid.uuid4()}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_project_200():
    client, session, app = await _client()
    try:
        updated = _mock_project("Updated Name")
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = updated
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.patch(f"/api/v2/projects/{PROJECT_ID}", json={"name": "Updated Name"})

        assert resp.status_code == 200
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_project_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_project()
        session.execute = AsyncMock(return_value=mock_result)
        session.delete = AsyncMock()
        session.flush = AsyncMock()

        async with client as c:
            resp = await c.delete(f"/api/v2/projects/{PROJECT_ID}")

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
    finally:
        app.dependency_overrides.clear()


# ── 7a03c5f1: per-project grant 인가 (정책B 정합) ─────────────────────────────
# 접근 모델: GET/PATCH = has_project_access(grant ∪ owner/admin), DELETE = owner/admin 전용.

def _found_session():
    """repo.get(id) 가 프로젝트를 찾도록(존재) 하는 mock_session."""
    session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = _mock_project()
    session.execute = AsyncMock(return_value=mock_result)
    session.delete = AsyncMock()
    session.flush = AsyncMock()
    return session


async def _client_with(session):
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    async def override_db():
        yield session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), app


@pytest.mark.anyio
async def test_get_project_unauthorized_404():
    """미부여 일반 org-member → GET 차단(404, 존재 비노출)."""
    client, app = await _client_with(_found_session())
    try:
        with patch("app.routers.projects.has_project_access", new=AsyncMock(return_value=False)):
            async with client as c:
                resp = await c.get(f"/api/v2/projects/{PROJECT_ID}")
        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_project_unauthorized_404():
    """미부여 일반 org-member → PATCH 차단(404)."""
    client, app = await _client_with(_found_session())
    try:
        with patch("app.routers.projects.has_project_access", new=AsyncMock(return_value=False)):
            async with client as c:
                resp = await c.patch(f"/api/v2/projects/{PROJECT_ID}", json={"name": "X"})
        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_project_unauthorized_404():
    """미부여 일반 org-member → DELETE 차단(404)."""
    client, app = await _client_with(_found_session())
    try:
        with patch("app.routers.projects.has_project_access", new=AsyncMock(return_value=False)):
            async with client as c:
                resp = await c.delete(f"/api/v2/projects/{PROJECT_ID}")
        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_project_granted_member_200():
    """부여 멤버 → GET 정상."""
    client, app = await _client_with(_found_session())
    try:
        with patch("app.routers.projects.has_project_access", new=AsyncMock(return_value=True)):
            async with client as c:
                resp = await c.get(f"/api/v2/projects/{PROJECT_ID}")
        assert resp.status_code == 200
        assert resp.json()["id"] == str(PROJECT_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_project_granted_member_200():
    """부여 멤버 → PATCH 정상."""
    client, app = await _client_with(_found_session())
    try:
        with patch("app.routers.projects.has_project_access", new=AsyncMock(return_value=True)):
            async with client as c:
                resp = await c.patch(f"/api/v2/projects/{PROJECT_ID}", json={"name": "Updated Name"})
        assert resp.status_code == 200
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_project_granted_member_forbidden_403():
    """부여 멤버지만 owner/admin 아님 → DELETE 차단(403, 파괴적 작업 권한 부족)."""
    client, app = await _client_with(_found_session())
    try:
        with patch("app.routers.projects.has_project_access", new=AsyncMock(return_value=True)), \
             patch("app.routers.projects.is_org_owner_or_admin", new=AsyncMock(return_value=False)):
            async with client as c:
                resp = await c.delete(f"/api/v2/projects/{PROJECT_ID}")
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_project_owner_admin_200():
    """owner/admin → DELETE 정상."""
    client, app = await _client_with(_found_session())
    try:
        with patch("app.routers.projects.has_project_access", new=AsyncMock(return_value=True)), \
             patch("app.routers.projects.is_org_owner_or_admin", new=AsyncMock(return_value=True)):
            async with client as c:
                resp = await c.delete(f"/api/v2/projects/{PROJECT_ID}")
        assert resp.status_code == 200
        assert resp.json()["ok"] is True
    finally:
        app.dependency_overrides.clear()
