"""E-MEMBER-POLICY S3 / AC#1: 멤버 per-project 역할 지정 엔드포인트(set_project_role).

권한(§9-3): project owner 또는 org owner/admin. role enum 검증. 대상 행 없으면 404.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _org_row(exists=True):
    r = MagicMock()
    r.first.return_value = (uuid.uuid4(),) if exists else None
    return r


def _update_result(rowcount):
    r = MagicMock()
    r.rowcount = rowcount
    return r


def _record(role):
    from app.models.project_access import ProjectAccess

    return ProjectAccess(
        id=uuid.uuid4(),
        project_id=uuid.uuid4(),
        org_member_id=None,
        member_id=uuid.uuid4(),
        permission="granted",
        role=role,
        created_at=datetime.now(timezone.utc),
    )


def _select_result(record):
    r = MagicMock()
    r.scalars.return_value.first.return_value = record
    return r


def _session(side_effect):
    s = MagicMock()
    s.execute = AsyncMock(side_effect=side_effect)
    s.commit = AsyncMock()
    return s


def _auth():
    a = MagicMock()
    a.user_id = str(uuid.uuid4())
    return a


def _patch_authz(proj_role, is_org_admin):
    return (
        patch("app.services.project_auth.get_project_role", new=AsyncMock(return_value=proj_role)),
        patch("app.services.project_auth.is_org_owner_or_admin", new=AsyncMock(return_value=is_org_admin)),
    )


@pytest.mark.anyio
async def test_invalid_role_400():
    from fastapi import HTTPException

    from app.routers import project_access as pa

    body = pa.SetProjectRoleRequest(role="manager")  # 비-enum
    session = _session([])
    with pytest.raises(HTTPException) as ei:
        await pa.set_project_role(uuid.uuid4(), uuid.uuid4(), body, auth=_auth(), session=session)
    assert ei.value.status_code == 400


@pytest.mark.anyio
async def test_missing_project_404():
    from fastapi import HTTPException

    from app.routers import project_access as pa

    body = pa.SetProjectRoleRequest(role="owner")
    session = _session([_org_row(exists=False)])
    with pytest.raises(HTTPException) as ei:
        await pa.set_project_role(uuid.uuid4(), uuid.uuid4(), body, auth=_auth(), session=session)
    assert ei.value.status_code == 404


@pytest.mark.anyio
async def test_unauthorized_403():
    """project owner 아님 + org owner/admin 아님 → 403 (project admin 도 불가)."""
    from fastapi import HTTPException

    from app.routers import project_access as pa

    body = pa.SetProjectRoleRequest(role="owner")
    session = _session([_org_row()])
    p1, p2 = _patch_authz(proj_role="admin", is_org_admin=False)
    with p1, p2, pytest.raises(HTTPException) as ei:
        await pa.set_project_role(uuid.uuid4(), uuid.uuid4(), body, auth=_auth(), session=session)
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_project_owner_can_set_role():
    from app.routers import project_access as pa

    body = pa.SetProjectRoleRequest(role="admin")
    session = _session([_org_row(), _update_result(1), _select_result(_record("admin"))])
    p1, p2 = _patch_authz(proj_role="owner", is_org_admin=False)
    with p1, p2:
        out = await pa.set_project_role(uuid.uuid4(), uuid.uuid4(), body, auth=_auth(), session=session)
    assert out.role == "admin"
    session.commit.assert_awaited_once()


@pytest.mark.anyio
async def test_org_admin_can_set_role():
    """org admin(project owner 아님)도 지정 가능(§9-3)."""
    from app.routers import project_access as pa

    body = pa.SetProjectRoleRequest(role="owner")
    session = _session([_org_row(), _update_result(1), _select_result(_record("owner"))])
    p1, p2 = _patch_authz(proj_role="member", is_org_admin=True)
    with p1, p2:
        out = await pa.set_project_role(uuid.uuid4(), uuid.uuid4(), body, auth=_auth(), session=session)
    assert out.role == "owner"


@pytest.mark.anyio
async def test_member_not_in_project_404():
    from fastapi import HTTPException

    from app.routers import project_access as pa

    body = pa.SetProjectRoleRequest(role="admin")
    session = _session([_org_row(), _update_result(0)])  # rowcount 0 = 대상 행 없음
    p1, p2 = _patch_authz(proj_role="owner", is_org_admin=False)
    with p1, p2, pytest.raises(HTTPException) as ei:
        await pa.set_project_role(uuid.uuid4(), uuid.uuid4(), body, auth=_auth(), session=session)
    assert ei.value.status_code == 404
