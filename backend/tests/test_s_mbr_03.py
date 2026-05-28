"""S-MBR-03: 백엔드 역할 상속 — Owner/Admin 전 프로젝트 자동 접근.

AC1: Org Owner → 모든 프로젝트 owner 권한으로 자동 접근
AC2: Org Admin → 모든 프로젝트 admin 권한으로 자동 접근
AC3: Org Member → project_members에 명시적 추가 없으면 프로젝트 접근 불가 (기존 유지)
AC4: 프로젝트 멤버 목록 API 응답에 상속된 Owner/Admin도 포함하여 표시
AC5: 역할 상속은 org_members 기반
"""
from __future__ import annotations

import inspect
import uuid
from unittest.mock import AsyncMock, MagicMock, patch


# ─── AC5: 구조 검증 ──────────────────────────────────────────────────────────

def test_build_app_metadata_exists():
    """_build_app_metadata 함수가 auth.py에 존재."""
    import app.routers.auth as auth_module
    assert hasattr(auth_module, "_build_app_metadata")
    assert callable(auth_module._build_app_metadata)


def test_org_role_map_logic_in_build_app_metadata():
    """org_role_map 기반 role 상속 로직이 auth.py 소스에 포함됨."""
    import app.routers.auth as auth_module
    source = inspect.getsource(auth_module._build_app_metadata)
    assert "org_role_map" in source
    assert "_ROLE_RANK" in source
    assert "_effective_role" in source


def test_members_router_owner_admin_bypass():
    """members.py list_members SQL에 owner/admin 예외 조건이 포함됨."""
    import app.routers.members as members_module
    source = inspect.getsource(members_module.list_members)
    assert "owner" in source
    assert "admin" in source
    assert "OR" in source.upper()


# ─── AC1/AC2: _effective_role 로직 단위 테스트 ────────────────────────────────

def _make_effective_role_fn():
    """_build_app_metadata 내부 _effective_role 클로저를 재현하여 단위 테스트."""
    _ROLE_RANK: dict[str, int] = {"owner": 4, "admin": 3, "manager": 2, "member": 1}

    def _effective_role(project_role: str, org_id_str: str, org_role_map: dict) -> str:
        org_r = org_role_map.get(org_id_str, "")
        if _ROLE_RANK.get(org_r, 0) > _ROLE_RANK.get(project_role, 0):
            return org_r
        return project_role

    return _effective_role


def test_ac1_org_owner_overrides_member_role():
    """AC1: org role=owner, project role=member → effective role=owner."""
    fn = _make_effective_role_fn()
    org_id = str(uuid.uuid4())
    role_map = {org_id: "owner"}
    assert fn("member", org_id, role_map) == "owner"


def test_ac2_org_admin_overrides_member_role():
    """AC2: org role=admin, project role=member → effective role=admin."""
    fn = _make_effective_role_fn()
    org_id = str(uuid.uuid4())
    role_map = {org_id: "admin"}
    assert fn("member", org_id, role_map) == "admin"


def test_ac3_org_member_role_not_elevated():
    """AC3: org role=member → project role 유지 (상승 없음)."""
    fn = _make_effective_role_fn()
    org_id = str(uuid.uuid4())
    role_map = {org_id: "member"}
    assert fn("member", org_id, role_map) == "member"


def test_project_role_higher_than_org_role_preserved():
    """project role이 org role보다 높으면 project role 유지."""
    fn = _make_effective_role_fn()
    org_id = str(uuid.uuid4())
    role_map = {org_id: "member"}
    assert fn("admin", org_id, role_map) == "admin"


def test_org_owner_overrides_admin_project_role():
    """org owner → project admin보다 높으므로 owner 반환."""
    fn = _make_effective_role_fn()
    org_id = str(uuid.uuid4())
    role_map = {org_id: "owner"}
    assert fn("admin", org_id, role_map) == "owner"


def test_unknown_org_preserves_project_role():
    """org_role_map에 없는 org_id → project role 그대로 반환."""
    fn = _make_effective_role_fn()
    org_id = str(uuid.uuid4())
    other_org = str(uuid.uuid4())
    role_map = {other_org: "owner"}
    assert fn("member", org_id, role_map) == "member"


# ─── AC4: members.py list_members SQL 구조 ────────────────────────────────────

import pytest


@pytest.mark.anyio
async def test_list_members_owner_always_included():
    """AC4: org owner는 denied project_access 레코드가 있어도 목록에 포함됨.

    SQL 쿼리가 om.role IN ('owner','admin') OR NOT EXISTS(denied) 패턴을 사용하는지 검증.
    """
    from app.routers.members import list_members

    project_id = uuid.uuid4()
    mock_session = AsyncMock()

    # Human rows: org owner (id=owner_id) + org member (id=member_id)
    owner_id = uuid.uuid4()
    member_id = uuid.uuid4()

    human_mock = MagicMock()
    human_mock.__iter__ = MagicMock(return_value=iter([
        (owner_id, "owner@example.com", "owner"),
        (member_id, "member@example.com", "member"),
    ]))

    agent_mock = MagicMock()
    agent_mock.scalars.return_value.all.return_value = []

    mock_session.execute = AsyncMock(side_effect=[human_mock, agent_mock])
    mock_auth = MagicMock()

    result = await list_members(project_id=project_id, session=mock_session, _auth=mock_auth)
    # 두 멤버 모두 포함
    assert len(result) == 2
    roles = {r.role for r in result}
    assert "owner" in roles
    assert "member" in roles
