"""E-MEMBER-POLICY S2: project_auth role 헬퍼(get_project_role/has_project_role) + 소비(_require_owner_or_admin)."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _role_result(org_role, proj_role):
    """get_project_role 의 SELECT (org_role, proj_role) 한 행."""
    r = MagicMock()
    r.one_or_none.return_value = (org_role, proj_role)
    return r


# ─── get_project_role: effective = max(project_access.role, org owner/admin floor) ──


@pytest.mark.anyio
@pytest.mark.parametrize(
    "org_role,proj_role,expected",
    [
        ("owner", None, "owner"),       # org owner → owner (floor)
        ("admin", None, "admin"),       # org admin → admin (floor)
        ("member", "owner", "owner"),   # project owner(org member) → owner
        ("member", "admin", "admin"),   # project admin(org member) → admin
        (None, "member", "member"),     # grant-only member
        ("member", "member", "member"), # org member + project member
        ("owner", "member", "owner"),   # org owner floors above project member (max)
        ("manager", "member", "member"),# org manager 는 floor 아님 → project member
        (None, None, None),             # 접근/역할 없음
        ("member", None, None),         # org member + project_access 행 없음 → 역할 없음
    ],
)
async def test_get_project_role_matrix(org_role, proj_role, expected):
    from app.services import project_auth as pa

    session = MagicMock()
    session.execute = AsyncMock(return_value=_role_result(org_role, proj_role))
    out = await pa.get_project_role(session, uuid.uuid4(), uuid.uuid4())
    assert out == expected


@pytest.mark.anyio
async def test_get_project_role_clamps_legacy_manager_proj_role():
    """project_access.role 에 레거시 'manager' 가 남아있어도(0122 전 행) clamp → member."""
    from app.services import project_auth as pa

    session = MagicMock()
    session.execute = AsyncMock(return_value=_role_result(None, "manager"))
    out = await pa.get_project_role(session, uuid.uuid4(), uuid.uuid4())
    assert out == "member"


# ─── has_project_role ─────────────────────────────────────────────────────────


@pytest.mark.anyio
@pytest.mark.parametrize(
    "org_role,proj_role,min_role,expected",
    [
        ("owner", None, "admin", True),
        ("admin", None, "admin", True),
        ("member", "owner", "admin", True),
        ("member", "admin", "admin", True),
        ("member", "member", "admin", False),
        (None, None, "admin", False),
        ("member", "member", "member", True),
        (None, None, "member", False),
        ("member", "admin", "owner", False),  # admin < owner
    ],
)
async def test_has_project_role(org_role, proj_role, min_role, expected):
    from app.services import project_auth as pa

    session = MagicMock()
    session.execute = AsyncMock(return_value=_role_result(org_role, proj_role))
    assert await pa.has_project_role(
        session, uuid.uuid4(), uuid.uuid4(), min_role=min_role
    ) is expected


# ─── _require_owner_or_admin 소비: 무회귀 + additive ─────────────────────────


async def _call_require(org_role, proj_role, project_exists=True):
    from app.routers import project_access as pr

    proj_res = MagicMock()
    proj_res.first.return_value = (uuid.uuid4(),) if project_exists else None
    role_res = _role_result(org_role, proj_role)
    session = MagicMock()
    session.execute = AsyncMock(side_effect=[proj_res, role_res])
    auth = MagicMock()
    auth.user_id = str(uuid.uuid4())
    await pr._require_owner_or_admin(uuid.uuid4(), auth, session)


@pytest.mark.anyio
async def test_require_org_owner_passes_no_regression():
    await _call_require("owner", None)  # 통과(예외 없음)


@pytest.mark.anyio
async def test_require_org_admin_passes_no_regression():
    await _call_require("admin", None)


@pytest.mark.anyio
async def test_require_project_owner_passes_additive():
    await _call_require("member", "owner")  # org member 지만 project owner → 통과(신규)


@pytest.mark.anyio
async def test_require_plain_member_403():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as ei:
        await _call_require("member", "member")
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_require_missing_project_404():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as ei:
        await _call_require("owner", None, project_exists=False)
    assert ei.value.status_code == 404
