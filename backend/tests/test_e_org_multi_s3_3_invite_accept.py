"""E-ORG-MULTI S3.3: 초대 수락 플로우 테스트.

AC1: GET /api/v2/invites/{token} — org/role 정보 공개 조회 (미인증)
AC2: 미인증 사용자 수락 시도 → 401
AC3: email 불일치 → 403
AC4: 수락 성공 → org_member 생성
AC5: 이미 수락된 초대 → 409
AC6: 만료 초대 → 410
AC7: 진입점 존재
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

ORG_ID = uuid.uuid4()
USER_ID = uuid.uuid4()
TOKEN = "valid_token_xyz"


def _mock_user(email: str = "invited@example.com") -> MagicMock:
    u = MagicMock()
    u.id = USER_ID
    u.email = email
    u.is_active = True
    return u


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client(user_id: uuid.UUID = USER_ID):
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(user_id)
    ctx.email = "invited@example.com"
    ctx.claims = {"app_metadata": {}}

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


# ─── AC7: 진입점 존재 ────────────────────────────────────────────────────────

def test_invite_accept_endpoints_exist():
    """GET /{token} + POST /accept 라우트 존재."""
    from app.main import app
    paths = {getattr(r, "path", "") for r in app.routes}
    assert "/api/v2/invites/{token}" in paths
    assert "/api/v2/invites/accept" in paths


# ─── AC1: 미인증 preview 조회 ────────────────────────────────────────────────

@pytest.mark.anyio
async def test_get_invite_preview_no_auth():
    """미인증 사용자도 토큰으로 초대 정보 조회 가능."""
    from app.main import app
    from app.routers.invite_accept import _get_repo
    from app.repositories.org_invite import InvitePreview
    from httpx import ASGITransport, AsyncClient

    mock_repo = MagicMock()
    mock_repo.get_preview = AsyncMock(return_value=InvitePreview(
        org_name="Test Org",
        role="member",
        status="pending",
        expires_at=datetime.now(timezone.utc) + timedelta(days=5),
        email="invited@example.com",
    ))
    app.dependency_overrides[_get_repo] = lambda: mock_repo

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get(f"/api/v2/invites/{TOKEN}")

        assert resp.status_code == 200
        data = resp.json()
        assert data["org_name"] == "Test Org"
        assert data["role"] == "member"
        assert data["status"] == "pending"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_invite_preview_not_found():
    """존재하지 않는 token → 404."""
    from app.main import app
    from app.routers.invite_accept import _get_repo
    from httpx import ASGITransport, AsyncClient

    mock_repo = MagicMock()
    mock_repo.get_preview = AsyncMock(return_value=None)
    app.dependency_overrides[_get_repo] = lambda: mock_repo

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get("/api/v2/invites/invalid_token")
        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


# ─── AC2: 미인증 수락 401 ────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_accept_invite_unauthenticated_401():
    """Authorization 없으면 401."""
    from app.main import app
    from httpx import ASGITransport, AsyncClient

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/api/v2/invites/accept", json={"token": TOKEN})
    assert resp.status_code in (401, 403)


# ─── AC3: email 불일치 403 ───────────────────────────────────────────────────

@pytest.mark.anyio
async def test_accept_invite_email_mismatch_403():
    """email 불일치 → 403."""
    client, session, app = await _client()
    try:
        from app.routers.invite_accept import _get_repo

        mock_repo = MagicMock()
        mock_repo.accept = AsyncMock(return_value={"ok": False, "reason": "email_mismatch"})

        user = _mock_user("different@example.com")
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = user
        session.execute = AsyncMock(return_value=mock_result)

        app.dependency_overrides[_get_repo] = lambda: mock_repo

        async with client as c:
            resp = await c.post("/api/v2/invites/accept", json={"token": TOKEN})

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


# ─── AC4: 수락 성공 + org_member 생성 ───────────────────────────────────────

@pytest.mark.anyio
async def test_accept_invite_success():
    """정상 수락 → 200 + org_id/role 반환."""
    client, session, app = await _client()
    try:
        from app.routers.invite_accept import _get_repo

        mock_repo = MagicMock()
        mock_repo.accept = AsyncMock(return_value={
            "ok": True, "org_id": str(ORG_ID), "role": "member"
        })

        user = _mock_user("invited@example.com")
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = user
        session.execute = AsyncMock(return_value=mock_result)
        session.commit = AsyncMock()

        app.dependency_overrides[_get_repo] = lambda: mock_repo

        async with client as c:
            resp = await c.post("/api/v2/invites/accept", json={"token": TOKEN})

        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert data["org_id"] == str(ORG_ID)
        assert data["role"] == "member"
    finally:
        app.dependency_overrides.clear()


# ─── AC5: 이미 수락된 초대 409 ───────────────────────────────────────────────

@pytest.mark.anyio
async def test_accept_invite_already_accepted_409():
    """이미 수락된 초대 → 409."""
    client, session, app = await _client()
    try:
        from app.routers.invite_accept import _get_repo

        mock_repo = MagicMock()
        mock_repo.accept = AsyncMock(return_value={"ok": False, "reason": "already_accepted"})

        user = _mock_user()
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = user
        session.execute = AsyncMock(return_value=mock_result)

        app.dependency_overrides[_get_repo] = lambda: mock_repo

        async with client as c:
            resp = await c.post("/api/v2/invites/accept", json={"token": TOKEN})

        assert resp.status_code == 409
    finally:
        app.dependency_overrides.clear()


# ─── AC6: 만료 초대 410 ──────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_accept_invite_expired_410():
    """만료된 초대 → 410."""
    client, session, app = await _client()
    try:
        from app.routers.invite_accept import _get_repo

        mock_repo = MagicMock()
        mock_repo.accept = AsyncMock(return_value={"ok": False, "reason": "expired"})

        user = _mock_user()
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = user
        session.execute = AsyncMock(return_value=mock_result)

        app.dependency_overrides[_get_repo] = lambda: mock_repo

        async with client as c:
            resp = await c.post("/api/v2/invites/accept", json={"token": TOKEN})

        assert resp.status_code == 410
    finally:
        app.dependency_overrides.clear()


# ─── 만료 상태 표시 검증 ─────────────────────────────────────────────────────

def test_get_preview_shows_expired_status():
    """만료된 pending 초대 → status='expired' 반환 로직 소스 검증."""
    import inspect
    from app.repositories.org_invite import OrgInviteRepository
    source = inspect.getsource(OrgInviteRepository.get_preview)
    assert "expired" in source
    assert "expires_at" in source


def test_accept_checks_email_mismatch_in_source():
    """accept 소스에 email 비교 로직 존재."""
    import inspect
    from app.repositories.org_invite import OrgInviteRepository
    source = inspect.getsource(OrgInviteRepository.accept)
    assert "email_mismatch" in source
    assert "email" in source


# ─── 졷버그(선생님 발견): same-invitee 재수락 멱등 ──────────────────────────────

def _accepted_invite(email: str = "invited@example.com") -> MagicMock:
    inv = MagicMock()
    inv.status = "accepted"
    inv.email = email
    inv.organization_id = ORG_ID
    inv.role = "member"
    return inv


@pytest.mark.anyio
async def test_accept_same_invitee_already_accepted_is_idempotent_success():
    """같은 초대받은이가 재수락(더블클릭/재방문/back) 시 409가 아니라 멱등 성공(이미 멤버)
    → FE가 /dashboard로 보낼 수 있다. (선생님 발견 'Invite already accepted' 버그 근본 fix)"""
    from app.repositories.org_invite import OrgInviteRepository

    sel = MagicMock()
    sel.scalar_one_or_none.return_value = _accepted_invite("invited@example.com")
    session = AsyncMock()
    session.execute = AsyncMock(return_value=sel)
    session.flush = AsyncMock()

    repo = OrgInviteRepository(session)
    out = await repo.accept(token=TOKEN, user_id=USER_ID, user_email="Invited@Example.com")  # 대소문자 무관

    assert out["ok"] is True
    assert out.get("already_member") is True
    assert out["org_id"] == str(ORG_ID)
    assert out["role"] == "member"


@pytest.mark.anyio
async def test_accept_different_user_already_accepted_still_rejected():
    """다른 유저가 이미 소비된 초대를 수락 시도 → already_accepted 유지(멱등 성공 아님)."""
    from app.repositories.org_invite import OrgInviteRepository

    sel = MagicMock()
    sel.scalar_one_or_none.return_value = _accepted_invite("invited@example.com")
    session = AsyncMock()
    session.execute = AsyncMock(return_value=sel)

    repo = OrgInviteRepository(session)
    out = await repo.accept(token=TOKEN, user_id=uuid.uuid4(), user_email="someone-else@example.com")

    assert out["ok"] is False
    assert out["reason"] == "already_accepted"
