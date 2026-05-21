"""S29 AC: Invitations 라우터 단위 테스트 (8건 이상)."""
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
INV_ID = uuid.uuid4()
TOKEN = "abc123deadbeef"


def _mock_invitation(status: str = "pending") -> MagicMock:
    inv = MagicMock()
    inv.id = INV_ID
    inv.org_id = ORG_ID
    inv.project_id = PROJECT_ID
    inv.invited_by = MEMBER_ID
    inv.email = "new@example.com"
    inv.role = "member"
    inv.token = TOKEN
    inv.status = status
    inv.expires_at = datetime.now(timezone.utc) + timedelta(days=7)
    inv.accepted_at = None
    inv.created_at = datetime(2026, 4, 30, tzinfo=timezone.utc)
    return inv


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client():
    from app.main import app

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID), "role": "admin"}, "email": "new@example.com"}

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
async def test_list_invitations_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.invitation.InvitationRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = [_mock_invitation()]

            async with client as c:
                resp = await c.get("/api/v2/invitations")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["email"] == "new@example.com"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_invitations_with_project_filter_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.invitation.InvitationRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = []

            async with client as c:
                resp = await c.get(f"/api/v2/invitations?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        assert resp.json() == []
        mock_list.assert_called_once_with(project_id=PROJECT_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_invitation_201():
    client, session, app = await _client()
    try:
        with patch("app.repositories.invitation.InvitationRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = _mock_invitation()

            async with client as c:
                resp = await c.post("/api/v2/invitations", json={
                    "email": "new@example.com",
                    "role": "member",
                    "invited_by": str(MEMBER_ID),
                })

        assert resp.status_code == 201
        assert resp.json()["status"] == "pending"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_revoke_invitation_200():
    client, session, app = await _client()
    try:
        revoked = _mock_invitation("revoked")
        with patch("app.repositories.invitation.InvitationRepository.revoke", new_callable=AsyncMock) as mock_revoke:
            mock_revoke.return_value = revoked

            async with client as c:
                resp = await c.delete(f"/api/v2/invitations/{INV_ID}")

        assert resp.status_code == 200
        assert resp.json()["status"] == "revoked"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_revoke_invitation_404():
    client, session, app = await _client()
    try:
        with patch("app.repositories.invitation.InvitationRepository.revoke", new_callable=AsyncMock) as mock_revoke:
            mock_revoke.return_value = None

            async with client as c:
                resp = await c.delete(f"/api/v2/invitations/{uuid.uuid4()}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_resend_invitation_200():
    client, session, app = await _client()
    try:
        refreshed = _mock_invitation("pending")
        refreshed.token = "newtokenhex"
        with patch("app.repositories.invitation.InvitationRepository.resend", new_callable=AsyncMock) as mock_resend:
            mock_resend.return_value = refreshed

            async with client as c:
                resp = await c.post(f"/api/v2/invitations/{INV_ID}/resend")

        assert resp.status_code == 200
        assert resp.json()["status"] == "pending"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_resend_invitation_404_when_revoked():
    client, session, app = await _client()
    try:
        with patch("app.repositories.invitation.InvitationRepository.resend", new_callable=AsyncMock) as mock_resend:
            mock_resend.return_value = None

            async with client as c:
                resp = await c.post(f"/api/v2/invitations/{INV_ID}/resend")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_accept_invitation_200():
    client, session, app = await _client()
    try:
        inv = _mock_invitation("pending")
        inv_result = MagicMock()
        inv_result.scalar_one_or_none.return_value = inv
        tm_result = MagicMock()
        tm_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(side_effect=[inv_result, MagicMock(), tm_result])
        session.flush = AsyncMock()

        async with client as c:
            resp = await c.post("/api/v2/invitations/accept", json={"token": TOKEN})

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
        assert resp.json()["org_id"] == str(ORG_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_accept_invitation_400_invalid_token():
    client, session, app = await _client()
    try:
        inv_result = MagicMock()
        inv_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=inv_result)

        async with client as c:
            resp = await c.post("/api/v2/invitations/accept", json={"token": "badtoken"})

        assert resp.status_code == 400
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_accept_invitation_creates_org_and_team_member():
    """직접 생성 경로: OrgMember + TeamMember 생성 호출 검증."""
    client, session, app = await _client()
    try:
        inv = _mock_invitation("pending")
        inv_result = MagicMock()
        inv_result.scalar_one_or_none.return_value = inv
        org_exec_result = MagicMock()
        session.execute = AsyncMock(side_effect=[inv_result, org_exec_result])
        session.flush = AsyncMock()
        session.add = MagicMock()

        async with client as c:
            resp = await c.post("/api/v2/invitations/accept", json={"token": TOKEN})

        assert resp.status_code == 200
        assert resp.json()["org_id"] == str(ORG_ID)
        assert resp.json()["project_id"] == str(PROJECT_ID)
        # OrgMember INSERT만 — human TeamMember 생성 제거됨 (E-ENTITY-CLEANUP S5)
        assert session.execute.call_count == 2
        assert session.flush.called
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_accept_invitation_403_email_mismatch():
    """다른 이메일로 발행된 초대 토큰 수락 시 403 반환 (권한 상승 방지)."""
    client, session, app = await _client()
    try:
        inv = _mock_invitation("pending")
        inv.email = "other@example.com"  # 로그인 유저(new@example.com)와 불일치
        inv_result = MagicMock()
        inv_result.scalar_one_or_none.return_value = inv
        session.execute = AsyncMock(return_value=inv_result)

        async with client as c:
            resp = await c.post("/api/v2/invitations/accept", json={"token": TOKEN})

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()
