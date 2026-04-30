"""C-S5: RLS → FastAPI 권한 검증 전환 — dependency injection 테스트"""
from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException


# ─── get_org_scope ────────────────────────────────────────────────────────────

def _make_auth(org_id: str | None = None, role: str = "member", project_ids: list | None = None):
    from app.dependencies.auth import AuthContext
    app_metadata: dict = {}
    if org_id:
        app_metadata["org_id"] = org_id
    if role:
        app_metadata["role"] = role
    if project_ids is not None:
        app_metadata["project_ids"] = project_ids
    return AuthContext(user_id="user-1", email="u@test.com", claims={"app_metadata": app_metadata})


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

def test_get_scope_context_returns_org_and_project():
    from app.dependencies.auth import get_scope_context
    org = uuid.uuid4()
    proj = uuid.uuid4()
    auth = _make_auth(org_id=str(org))
    ctx = get_scope_context(auth=auth, x_org_id=None, x_project_id=str(proj))
    assert ctx["org_id"] == org
    assert ctx["project_id"] == proj
    assert ctx["user_id"] == "user-1"


def test_get_scope_context_project_none_when_not_provided():
    from app.dependencies.auth import get_scope_context
    org = uuid.uuid4()
    auth = _make_auth(org_id=str(org))
    ctx = get_scope_context(auth=auth, x_org_id=None, x_project_id=None)
    assert ctx["org_id"] == org
    assert ctx["project_id"] is None


# ─── AuthContext org_id field ──────────────────────────────────────────────────

def test_auth_context_includes_org_id_from_jwt():
    """get_current_user가 JWT app_metadata.org_id를 AuthContext.org_id에 포함."""
    with patch.dict("os.environ", {"JWT_SECRET": "test-secret"}):
        from app.core.security import create_access_token
        token = create_access_token("user-1", email="a@b.com", app_metadata={"org_id": "org-abc"})

    from fastapi.security import HTTPAuthorizationCredentials
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)

    with patch.dict("os.environ", {"JWT_SECRET": "test-secret"}):
        from app.dependencies.auth import get_current_user
        ctx = get_current_user(credentials=creds)

    assert ctx.org_id == "org-abc"
    assert ctx.user_id == "user-1"
