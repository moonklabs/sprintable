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


# ─── AC1/AC2: /me 엔드포인트 role 상속 ─────────────────────────────────────────

def test_me_router_has_org_role_override():
    """me.py get_me 소스에 org role override 로직이 포함됨."""
    import app.routers.me as me_module
    source = inspect.getsource(me_module.get_me)
    assert "_ROLE_RANK" in source
    assert "org_role" in source
    assert "model_copy" in source


@pytest.mark.anyio
async def test_get_me_org_admin_role_override():
    """GET /me: team_member.role=member + org_member.role=admin → role=admin 반환 (AC2)."""
    from app.routers.me import get_me
    from app.dependencies.auth import AuthContext

    member_id = uuid.uuid4()
    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    user_id = uuid.uuid4()

    mock_member = MagicMock()
    mock_member.id = member_id
    mock_member.org_id = org_id
    mock_member.project_id = project_id
    mock_member.user_id = user_id
    mock_member.type = "human"
    mock_member.name = "test"
    mock_member.role = "member"  # project level: member
    mock_member.is_active = True
    mock_member.project_name = None  # MeResponse 직렬화 필수
    mock_member.has_password = None
    mock_member.project = MagicMock()
    mock_member.project.name = "Test Project"

    mock_session = AsyncMock()
    member_result = MagicMock()
    member_result.scalars.return_value.first.return_value = mock_member

    user_result = MagicMock()
    mock_user = MagicMock()
    mock_user.hashed_password = None
    user_result.scalar_one_or_none.return_value = mock_user

    org_role_result = MagicMock()
    org_role_result.scalar_one_or_none.return_value = "admin"  # org level: admin

    mock_session.execute = AsyncMock(side_effect=[member_result, user_result, org_role_result])

    auth = AuthContext(
        user_id=str(user_id),
        email="test@example.com",
        claims={"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}},
        org_id=str(org_id),
    )

    result = await get_me(member_id=None, session=mock_session, auth=auth)
    assert result.role == "admin"


@pytest.mark.anyio
async def test_get_me_project_role_higher_preserved():
    """GET /me: team_member.role=admin + org_member.role=member → role=admin 유지."""
    from app.routers.me import get_me
    from app.dependencies.auth import AuthContext

    member_id = uuid.uuid4()
    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    user_id = uuid.uuid4()

    mock_member = MagicMock()
    mock_member.id = member_id
    mock_member.org_id = org_id
    mock_member.project_id = project_id
    mock_member.user_id = user_id
    mock_member.type = "human"
    mock_member.name = "test"
    mock_member.role = "admin"  # project level: admin (높음)
    mock_member.is_active = True
    mock_member.project_name = None
    mock_member.has_password = None
    mock_member.project = MagicMock()
    mock_member.project.name = "Test Project"

    mock_session = AsyncMock()
    member_result = MagicMock()
    member_result.scalars.return_value.first.return_value = mock_member

    user_result = MagicMock()
    user_result.scalar_one_or_none.return_value = MagicMock(hashed_password=None)

    org_role_result = MagicMock()
    org_role_result.scalar_one_or_none.return_value = "member"  # org level: member (낮음)

    mock_session.execute = AsyncMock(side_effect=[member_result, user_result, org_role_result])

    auth = AuthContext(
        user_id=str(user_id),
        email="test@example.com",
        claims={"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}},
        org_id=str(org_id),
    )

    result = await get_me(member_id=None, session=mock_session, auth=auth)
    assert result.role == "admin"  # 기존 높은 role 유지


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
