"""C-S5: RLS → FastAPI 권한 검증 전환 — dependency injection 테스트"""
from __future__ import annotations

import types
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException


# ─── get_org_scope ────────────────────────────────────────────────────────────

def _make_auth(org_id: str | None = None, role: str = "member", project_ids: list | None = None, user_id: str = "user-1"):
    from app.dependencies.auth import AuthContext
    app_metadata: dict = {}
    if org_id:
        app_metadata["org_id"] = org_id
    if role:
        app_metadata["role"] = role
    if project_ids is not None:
        app_metadata["project_ids"] = project_ids
    return AuthContext(user_id=user_id, email="u@test.com", claims={"app_metadata": app_metadata})


def test_get_org_scope_from_jwt():
    from app.dependencies.auth import get_org_scope
    org = uuid.uuid4()
    auth = _make_auth(org_id=str(org))
    result = get_org_scope(auth=auth, x_org_id=None)
    assert result == org


def test_get_org_scope_from_header():
    from app.dependencies.auth import get_org_scope
    org = uuid.uuid4()
    auth = _make_auth(org_id=None)
    result = get_org_scope(auth=auth, x_org_id=str(org))
    assert result == org


def test_get_org_scope_jwt_takes_precedence():
    from app.dependencies.auth import get_org_scope
    jwt_org = uuid.uuid4()
    header_org = uuid.uuid4()
    auth = _make_auth(org_id=str(jwt_org))
    result = get_org_scope(auth=auth, x_org_id=str(header_org))
    assert result == jwt_org


def test_get_org_scope_missing_raises_400():
    from app.dependencies.auth import get_org_scope
    auth = _make_auth(org_id=None)
    with pytest.raises(HTTPException) as exc:
        get_org_scope(auth=auth, x_org_id=None)
    assert exc.value.status_code == 400


def test_get_org_scope_invalid_uuid_raises_400():
    from app.dependencies.auth import get_org_scope
    auth = _make_auth(org_id=None)
    with pytest.raises(HTTPException) as exc:
        get_org_scope(auth=auth, x_org_id="not-a-uuid")
    assert exc.value.status_code == 400


# ─── require_role ─────────────────────────────────────────────────────────────

def test_require_role_passes_for_allowed():
    from app.dependencies.auth import require_role
    auth = _make_auth(role="admin")
    checker = require_role("admin", "member")
    result = checker(auth=auth)
    assert result.user_id == "user-1"


def test_require_role_raises_403_for_disallowed():
    from app.dependencies.auth import require_role
    auth = _make_auth(role="viewer")
    checker = require_role("admin", "member")
    with pytest.raises(HTTPException) as exc:
        checker(auth=auth)
    assert exc.value.status_code == 403


def test_require_role_defaults_to_member():
    from app.dependencies.auth import require_role
    from app.dependencies.auth import AuthContext
    auth = AuthContext(user_id="u", email=None, claims={})
    checker = require_role("member")
    result = checker(auth=auth)
    assert result is auth


# ─── require_admin ────────────────────────────────────────────────────────────

def test_require_admin_passes():
    from app.dependencies.auth import require_admin
    auth = _make_auth(role="admin")
    result = require_admin(auth=auth)
    assert result is auth


def test_require_admin_blocks_member():
    from app.dependencies.auth import require_admin
    auth = _make_auth(role="member")
    with pytest.raises(HTTPException) as exc:
        require_admin(auth=auth)
    assert exc.value.status_code == 403


# ─── require_project_access ───────────────────────────────────────────────────

def test_require_project_access_passes_when_project_in_list():
    from app.dependencies.auth import require_project_access
    pid = uuid.uuid4()
    auth = _make_auth(project_ids=[str(pid)])
    result = require_project_access(project_id=pid, auth=auth)
    assert result == pid


def test_require_project_access_blocks_unlisted_project():
    from app.dependencies.auth import require_project_access
    pid = uuid.uuid4()
    other = uuid.uuid4()
    auth = _make_auth(project_ids=[str(other)])
    with pytest.raises(HTTPException) as exc:
        require_project_access(project_id=pid, auth=auth)
    assert exc.value.status_code == 403


def test_require_project_access_allows_legacy_token_without_project_ids():
    """project_ids 클레임 없는 레거시 토큰은 Phase C 전환 기간 허용."""
    from app.dependencies.auth import require_project_access
    pid = uuid.uuid4()
    auth = _make_auth(project_ids=None)
    result = require_project_access(project_id=pid, auth=auth)
    assert result == pid


# ─── get_scope_context ────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_get_scope_context_returns_org_and_project():
    from app.dependencies.auth import get_scope_context
    org = uuid.uuid4()
    proj = uuid.uuid4()
    uid = str(uuid.uuid4())
    auth = _make_auth(org_id=str(org), user_id=uid)

    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = proj  # has_project_access → True(멤버)
    mock_db = AsyncMock()
    mock_db.execute = AsyncMock(return_value=mock_result)
    mock_request = MagicMock()
    mock_request.state = types.SimpleNamespace()

    ctx = await get_scope_context(
        auth=auth, x_org_id=None, x_project_id=str(proj),
        db=mock_db, request=mock_request,
    )
    assert ctx["org_id"] == org
    assert ctx["project_id"] == proj
    assert ctx["user_id"] == uid


@pytest.mark.anyio
async def test_get_scope_context_project_none_when_not_provided():
    from app.dependencies.auth import get_scope_context
    org = uuid.uuid4()
    auth = _make_auth(org_id=str(org))
    ctx = await get_scope_context(auth=auth, x_org_id=None, x_project_id=None, db=None, request=None)
    assert ctx["org_id"] == org
    assert ctx["project_id"] is None


# ─── SEC-02 IDOR 차단 보안 테스트 ────────────────────────────────────────────────

@pytest.mark.anyio
async def test_get_verified_org_id_403_on_foreign_org():
    """X-Org-Id 헤더로 비소속 org 접근 시 403."""
    from app.dependencies.auth import get_verified_org_id
    caller_id = str(uuid.uuid4())
    auth = _make_auth(org_id=None, user_id=caller_id)  # JWT에 org_id 없음 → 헤더 fallback

    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None  # 멤버 아님
    mock_db = AsyncMock()
    mock_db.execute = AsyncMock(return_value=mock_result)
    mock_request = MagicMock()
    mock_request.state = types.SimpleNamespace()

    with pytest.raises(HTTPException) as exc_info:
        await get_verified_org_id(
            auth=auth,
            x_org_id=str(uuid.uuid4()),
            x_project_id=None,
            db=mock_db,
            request=mock_request,
        )
    assert exc_info.value.status_code == 403


@pytest.mark.anyio
async def test_get_verified_org_id_pass_when_member():
    """X-Org-Id 헤더로 소속 org 접근 시 정상 통과."""
    from app.dependencies.auth import get_verified_org_id
    org = uuid.uuid4()
    caller_id = str(uuid.uuid4())
    auth = _make_auth(org_id=None, user_id=caller_id)

    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = MagicMock()  # 멤버임
    mock_db = AsyncMock()
    mock_db.execute = AsyncMock(return_value=mock_result)
    mock_request = MagicMock()
    mock_request.state = types.SimpleNamespace()

    result = await get_verified_org_id(
        auth=auth,
        x_org_id=str(org),
        x_project_id=None,
        db=mock_db,
        request=mock_request,
    )
    assert result == org


@pytest.mark.anyio
async def test_get_verified_org_id_jwt_org_skips_db():
    """JWT에 org_id 있으면 DB 조회 없이 통과 (N+1 방지 경로 확인)."""
    from app.dependencies.auth import get_verified_org_id
    org = uuid.uuid4()
    auth = _make_auth(org_id=str(org))

    mock_db = AsyncMock()
    mock_request = MagicMock()
    mock_request.state = types.SimpleNamespace()

    result = await get_verified_org_id(
        auth=auth, x_org_id=None, x_project_id=None, db=mock_db, request=mock_request,
    )
    assert result == org
    mock_db.execute.assert_not_called()


@pytest.mark.anyio
async def test_get_verified_org_id_403_on_foreign_project():
    """X-Project-Id 헤더로 비소속(has_project_access=False) project 접근 시 403."""
    from app.dependencies.auth import get_verified_org_id
    org = uuid.uuid4()
    auth = _make_auth(org_id=str(org), user_id=str(uuid.uuid4()))  # JWT에 org_id 있음 (org 검증 skip)

    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None  # has_project_access → False(멤버 아님)
    mock_db = AsyncMock()
    mock_db.execute = AsyncMock(return_value=mock_result)
    mock_request = MagicMock()
    mock_request.state = types.SimpleNamespace()

    with pytest.raises(HTTPException) as exc_info:
        await get_verified_org_id(
            auth=auth,
            x_org_id=None,
            x_project_id=str(uuid.uuid4()),
            db=mock_db,
            request=mock_request,
        )
    assert exc_info.value.status_code == 403


# ─── SEC-05 API Key scope 테스트 ────────────────────────────────────────────────

def _make_api_key_auth(org_id: str, scope: list[str]) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(uuid.uuid4()),
        email=None,
        claims={
            "app_metadata": {
                "org_id": org_id,
                "scope": scope,
                "api_key_id": str(uuid.uuid4()),
            }
        },
        org_id=org_id,
    )


def test_api_key_read_scope_blocks_post():
    """read-only API Key로 POST 시도 → 403."""
    from app.dependencies.auth import _check_api_key_scope
    auth = _make_api_key_auth(str(uuid.uuid4()), ["read"])
    with pytest.raises(HTTPException) as exc_info:
        _check_api_key_scope(auth, "POST")
    assert exc_info.value.status_code == 403


def test_api_key_write_scope_allows_post():
    """write scope API Key로 POST → 통과."""
    from app.dependencies.auth import _check_api_key_scope
    auth = _make_api_key_auth(str(uuid.uuid4()), ["read", "write"])
    _check_api_key_scope(auth, "POST")  # 예외 없음


def test_api_key_read_scope_allows_get():
    """read scope API Key로 GET → 통과."""
    from app.dependencies.auth import _check_api_key_scope
    auth = _make_api_key_auth(str(uuid.uuid4()), ["read"])
    _check_api_key_scope(auth, "GET")  # 예외 없음


def test_jwt_user_skips_scope_check():
    """JWT 사용자(api_key_id 없음)는 scope 체크 미적용."""
    from app.dependencies.auth import _check_api_key_scope
    auth = _make_auth(org_id=str(uuid.uuid4()))  # api_key_id 없음
    _check_api_key_scope(auth, "DELETE")  # 예외 없음 (스킵)


def test_require_api_scope_factory_blocks_missing_scope():
    """require_api_scope("write")가 read-only API Key에 403 반환."""
    from app.dependencies.auth import require_api_scope, AuthContext
    checker = require_api_scope("write")
    auth = _make_api_key_auth(str(uuid.uuid4()), ["read"])
    with pytest.raises(HTTPException) as exc_info:
        checker(auth=auth)
    assert exc_info.value.status_code == 403


def test_require_api_scope_factory_passes_jwt():
    """require_api_scope()는 JWT 사용자 스킵."""
    from app.dependencies.auth import require_api_scope
    checker = require_api_scope("write")
    auth = _make_auth(org_id=str(uuid.uuid4()))
    checker(auth=auth)  # 예외 없음


# ─── AuthContext org_id field ──────────────────────────────────────────────────

def test_auth_context_includes_org_id_from_jwt():
    """get_current_user가 JWT app_metadata.org_id를 AuthContext.org_id에 포함."""
    with patch.dict("os.environ", {"JWT_SECRET": "test-secret"}):
        from app.core.security import create_access_token
        token = create_access_token("user-1", email="a@b.com", app_metadata={"org_id": "org-abc"})

    from fastapi.security import HTTPAuthorizationCredentials
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)

    import asyncio
    with patch.dict("os.environ", {"JWT_SECRET": "test-secret"}):
        from app.dependencies.auth import get_current_user
        ctx = asyncio.run(get_current_user(credentials=creds, x_agent_api_key=None, db=None))

    assert ctx.org_id == "org-abc"
    assert ctx.user_id == "user-1"
