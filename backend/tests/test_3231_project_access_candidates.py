"""story #3231 4라운드(카디르 QA) — GET /api/v2/projects/{id}/access-candidates.

org-members roster를 admin 전용 403으로 잠그면서(3231 1라운드) project-access-
section.tsx가 org-admin이 아닌 project-level effective admin(org owner/admin 플로어
OR project-level owner/admin — additive, _require_owner_or_admin/has_project_role)을
새로 막았다(신규 회귀). 이 엔드포인트는 list_project_access(기존 GET /{project_id}/
access)와 동일 게이트를 재사용해 그 effective 역할로만 인가한다.
"""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

PROJECT_ID = uuid.uuid4()
ORG_ID = uuid.uuid4()
CALLER_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client():
    from app.main import app

    ctx = MagicMock()
    ctx.user_id = str(CALLER_ID)
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    from app.dependencies.auth import get_current_user
    from tests.conftest import override_db_and_read
    override_db_and_read(app, override_db)
    app.dependency_overrides[get_current_user] = override_auth

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


def _project_org_row():
    row = MagicMock()
    row.org_id = ORG_ID
    result = MagicMock()
    result.first.return_value = row
    return result


def _org_member_row_result():
    row = MagicMock()
    row.id = uuid.uuid4()
    row.org_id = ORG_ID
    row.user_id = uuid.uuid4()
    row.role = "member"
    row.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    row.deleted_at = None
    row.email = "candidate@example.com"
    row.name = "Candidate Member"
    result = MagicMock()
    result.__iter__ = MagicMock(return_value=iter([row]))
    return result


@pytest.mark.anyio
async def test_access_candidates_project_level_admin_allowed():
    """org-admin이 아니어도(project-level effective admin) 통과한다 — 신규 회귀 정면 pin."""
    client, session, app = await _client()
    try:
        # 호출 순서: _require_owner_or_admin의 project→org_id 조회, has_project_role(패치로
        # 우회), 엔드포인트 자체의 project→org_id 재조회, org_members JOIN 조회.
        call_count = 0

        async def mock_execute(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count in (1, 2):
                return _project_org_row()
            return _org_member_row_result()
        session.execute = mock_execute

        with patch("app.services.project_auth.has_project_role", new=AsyncMock(return_value=True)):
            async with client as c:
                resp = await c.get(f"/api/v2/projects/{PROJECT_ID}/access-candidates")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["email"] == "candidate@example.com"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_access_candidates_non_admin_403():
    """effective 역할이 admin 미만이면 403 — 로스터 쿼리까지 도달 안 함(원 결함 재발 시
    감지되도록 org_members JOIN 쿼리 도달 자체를 감시)."""
    client, session, app = await _client()
    try:
        call_count = 0

        async def mock_execute(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return _project_org_row()
            raise AssertionError("has_project_role 검증을 통과해 로스터 쿼리까지 도달함 — 원 결함 재발")
        session.execute = mock_execute

        with patch("app.services.project_auth.has_project_role", new=AsyncMock(return_value=False)):
            async with client as c:
                resp = await c.get(f"/api/v2/projects/{PROJECT_ID}/access-candidates")

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_access_candidates_project_not_found_404():
    client, session, app = await _client()
    try:
        result = MagicMock()
        result.first.return_value = None
        session.execute = AsyncMock(return_value=result)

        async with client as c:
            resp = await c.get(f"/api/v2/projects/{PROJECT_ID}/access-candidates")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()
