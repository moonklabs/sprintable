"""AUTH: switch-project 엔드포인트 + _build_app_metadata 멀티프로젝트 수정 테스트."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _make_user(last_project_id=None) -> MagicMock:
    u = MagicMock()
    u.id = uuid.uuid4()
    u.email = "user@example.com"
    u.hashed_password = ""
    u.is_active = True
    u.last_project_id = last_project_id
    return u


def _make_member(project_id=None, org_id=None, is_active=True) -> MagicMock:
    m = MagicMock()
    m.id = uuid.uuid4()
    m.user_id = uuid.uuid4()
    m.project_id = project_id or uuid.uuid4()
    m.org_id = org_id or uuid.uuid4()
    m.role = "member"
    m.is_active = is_active
    m.created_at = datetime.now(timezone.utc)
    m.type = "human"
    return m


@pytest.fixture
def mock_session():
    session = AsyncMock()
    session.add = MagicMock()
    session.flush = AsyncMock()
    session.commit = AsyncMock()
    session.refresh = AsyncMock()
    session.execute = AsyncMock()
    return session


@pytest.fixture
def org_id():
    return uuid.uuid4()


@pytest.fixture
def auth_ctx(org_id):
    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "user@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(org_id)}}
    return ctx


@pytest.fixture
async def client(mock_session, auth_ctx):
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from app.main import app

    async def _db():
        yield mock_session

    async def _auth():
        return auth_ctx

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


# ─── AC5-1: switch-project 성공 ──────────────────────────────────────────────

@pytest.mark.anyio
async def test_switch_project_success_returns_new_tokens(client, mock_session, auth_ctx):
    """POST /auth/switch-project → 200 + 새 토큰."""
    user = _make_user()
    auth_ctx.user_id = str(user.id)
    project_id = uuid.uuid4()
    member = _make_member(project_id=project_id)
    member2 = _make_member(project_id=project_id)

    # user 조회 → member 검증 → all_members 조회
    user_result = MagicMock()
    user_result.scalar_one_or_none.return_value = user
    member_result = MagicMock()
    member_result.scalar_one_or_none.return_value = member
    all_members_scalars = MagicMock()
    all_members_scalars.all.return_value = [member, member2]
    all_members_result = MagicMock()
    all_members_result.scalars.return_value = all_members_scalars
    revoke_result = MagicMock()

    # switch_project에서 user.last_project_id = project_id 설정 후 _build_app_metadata 호출
    # → last_project_id 있으므로 해당 project member 조회 → member 반환
    last_project_result = MagicMock()
    last_project_result.scalar_one_or_none.return_value = member

    mock_session.execute.side_effect = [
        user_result,         # _get_user_by_id
        member_result,       # validate membership
        revoke_result,       # revoke old refresh tokens
        last_project_result, # _build_app_metadata: last_project_id member 조회
        all_members_result,  # _build_app_metadata: all projects
    ]

    with patch("app.routers.auth.create_tokens") as mock_create, \
         patch("app.routers.auth._store_refresh_token") as mock_store:
        mock_create.return_value = {
            "access_token": "new-access",
            "refresh_token": "new-refresh",
            "token_type": "bearer",
            "refresh_expires_at": "2026-06-12T00:00:00Z",
        }
        mock_store.return_value = None

        resp = await client.post("/api/v2/auth/switch-project", json={"project_id": str(project_id)})

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["access_token"] == "new-access"
    assert user.last_project_id == project_id


# ─── AC5-2: 비멤버 프로젝트 403 ──────────────────────────────────────────────

@pytest.mark.anyio
async def test_switch_project_not_member_returns_403(client, mock_session, auth_ctx):
    """비멤버 project로 switch → 403."""
    user = _make_user()
    auth_ctx.user_id = str(user.id)

    user_result = MagicMock()
    user_result.scalar_one_or_none.return_value = user
    member_result = MagicMock()
    member_result.scalar_one_or_none.return_value = None  # 멤버 아님

    mock_session.execute.side_effect = [user_result, member_result]

    resp = await client.post("/api/v2/auth/switch-project", json={"project_id": str(uuid.uuid4())})
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "NOT_MEMBER"


# ─── AC5-3: 비활성 team_member 거부 ──────────────────────────────────────────

@pytest.mark.anyio
async def test_switch_project_inactive_member_returns_403(client, mock_session, auth_ctx):
    """비활성(is_active=False) team_member는 403."""
    user = _make_user()
    auth_ctx.user_id = str(user.id)

    user_result = MagicMock()
    user_result.scalar_one_or_none.return_value = user
    # is_active.is_(True) 조건으로 필터링되므로 None 반환
    member_result = MagicMock()
    member_result.scalar_one_or_none.return_value = None

    mock_session.execute.side_effect = [user_result, member_result]

    resp = await client.post("/api/v2/auth/switch-project", json={"project_id": str(uuid.uuid4())})
    assert resp.status_code == 403


# ─── AC5-4: cross-org 취약점 차단 ────────────────────────────────────────────

@pytest.mark.anyio
async def test_switch_project_cross_org_returns_403(mock_session, auth_ctx):
    """다른 org의 project로 switch 시도 → 403 (org_id 조건으로 차단)."""
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from app.main import app

    user = _make_user()
    org_a = uuid.uuid4()
    auth_ctx.user_id = str(user.id)
    # JWT에 org A 설정
    auth_ctx.claims = {"app_metadata": {"org_id": str(org_a)}}

    async def _db():
        yield mock_session

    async def _auth():
        return auth_ctx

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth

    user_result = MagicMock()
    user_result.scalar_one_or_none.return_value = user
    # org_id == org_a 조건으로 org B project의 member 조회 시 None
    member_result = MagicMock()
    member_result.scalar_one_or_none.return_value = None
    mock_session.execute.side_effect = [user_result, member_result]

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post(
                "/api/v2/auth/switch-project",
                json={"project_id": str(uuid.uuid4())},  # org B의 project_id
            )
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "NOT_MEMBER"
    finally:
        app.dependency_overrides.clear()


# ─── AC2: _build_app_metadata last_project_id 우선 선택 ─────────────────────

@pytest.mark.anyio
async def test_build_app_metadata_uses_last_project_id():
    """last_project_id 있으면 해당 project의 team_member 우선 선택."""
    from app.routers.auth import _build_app_metadata

    target_project = uuid.uuid4()
    user = _make_user(last_project_id=target_project)

    target_member = _make_member(project_id=target_project)
    old_member = _make_member()  # 더 오래된 다른 project

    session = AsyncMock()

    # 1st execute: last_project_id 기반 조회 → target_member 반환
    last_project_result = MagicMock()
    last_project_result.scalar_one_or_none.return_value = target_member
    # projects 목록 조회
    all_scalars = MagicMock()
    all_scalars.all.return_value = [target_member, old_member]
    all_result = MagicMock()
    all_result.scalars.return_value = all_scalars

    session.execute.side_effect = [last_project_result, all_result]

    result = await _build_app_metadata(user, session)

    assert result["project_id"] == str(target_project)
    assert "projects" in result
    assert len(result["projects"]) == 2


@pytest.mark.anyio
async def test_build_app_metadata_fallback_desc_when_no_last_project():
    """last_project_id 없으면 created_at DESC (최신) 기반 fallback."""
    from app.routers.auth import _build_app_metadata

    user = _make_user(last_project_id=None)
    latest_member = _make_member()

    session = AsyncMock()

    # 1st execute: fallback DESC 조회 → latest_member 반환
    fallback_result = MagicMock()
    fallback_result.scalar_one_or_none.return_value = latest_member
    # projects 목록 조회
    all_scalars = MagicMock()
    all_scalars.all.return_value = [latest_member]
    all_result = MagicMock()
    all_result.scalars.return_value = all_scalars

    session.execute.side_effect = [fallback_result, all_result]

    result = await _build_app_metadata(user, session)

    assert result["project_id"] == str(latest_member.project_id)
    assert "projects" in result


# ─── migration 파일 존재 확인 ─────────────────────────────────────────────────

def test_migration_0026_exists():
    import os
    path = os.path.join(
        os.path.dirname(__file__), "..", "alembic", "versions",
        "0026_add_last_project_id_to_users.py"
    )
    assert os.path.exists(path)


def test_user_model_has_last_project_id():
    from app.models.user import User
    assert hasattr(User, "last_project_id")
