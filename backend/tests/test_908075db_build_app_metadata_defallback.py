"""908075db 단계1: _build_app_metadata de-fallback (flag-gated 명시존중).

flag on이면 명시 의도(switch target project_id 또는 저장된 last_project_id)에 has_project_access
(35a0691e grant-aware)가 있을 때 가장-오래된-team_member 추측을 타지 않고 그 project를 존중한다.
side-effect(last_project_id 덮어쓰기)는 단계2서 제거 — 단계1 명시존중 분기 자체는 부수효과 없음.
flag off(기본)면 분기 통째 skip → 기존 거동 100% 유지(회귀 0).
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_A = uuid.uuid4()
PID_EXPLICIT = uuid.uuid4()   # 명시 의도(last_project_id / switch target)
PID_TARGET = uuid.uuid4()     # switch target param
PID_OLD = uuid.uuid4()        # 저장된 옛 last_project_id
UID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _user(last_project_id=None, last_org_id=ORG_A):
    u = MagicMock()
    u.id = UID
    u.email = "x@example.com"
    u.last_project_id = last_project_id
    u.last_org_id = last_org_id
    return u


def _explicit_helper_execs(proj_org, tm_role, om_role):
    """_resolve_explicit_app_metadata 내부 execute 3회: project.org_id → team_member → org_member role."""
    q_proj = MagicMock(); q_proj.scalar_one_or_none.return_value = proj_org
    q_tm = MagicMock()
    q_tm.scalar_one_or_none.return_value = (
        MagicMock(role=tm_role) if tm_role is not None else None
    )
    q_om = MagicMock(); q_om.scalar_one_or_none.return_value = om_role
    return [q_proj, q_tm, q_om]


@pytest.mark.anyio
async def test_flag_on_explicit_last_project_respected_grant_only():
    """flag on + 저장된 last_project_id가 grant-only(team_member 0)라도 has_project_access면 그대로 존중.
    추측 fallback 안 탐 + side-effect(last_project_id 변경) 없음."""
    from app.routers.auth import _build_app_metadata

    user = _user(last_project_id=PID_EXPLICIT)
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=_explicit_helper_execs(ORG_A, None, "member"))

    with patch("app.routers.auth.settings.build_app_metadata_defallback", True), \
         patch("app.routers.auth.has_project_access", new=AsyncMock(return_value=True)), \
         patch("app.routers.auth._user_projects_claim", new=AsyncMock(return_value=[])):
        md = await _build_app_metadata(user, session)

    assert md["project_id"] == str(PID_EXPLICIT)   # 명시 의도 존중(추측 아님)
    assert md["org_id"] == str(ORG_A)
    assert md["role"] == "member"                  # grant-only → org_member role
    assert user.last_project_id == PID_EXPLICIT    # 부수효과 없음(불변)


@pytest.mark.anyio
async def test_flag_on_team_member_inherits_org_role():
    """flag on + team_member project → owner/admin org role 상속(effective)."""
    from app.routers.auth import _build_app_metadata

    user = _user(last_project_id=PID_EXPLICIT)
    session = AsyncMock()
    # team_member role=manager(2), org role=admin(3) → effective admin
    session.execute = AsyncMock(side_effect=_explicit_helper_execs(ORG_A, "manager", "admin"))

    with patch("app.routers.auth.settings.build_app_metadata_defallback", True), \
         patch("app.routers.auth.has_project_access", new=AsyncMock(return_value=True)), \
         patch("app.routers.auth._user_projects_claim", new=AsyncMock(return_value=[])):
        md = await _build_app_metadata(user, session)

    assert md["project_id"] == str(PID_EXPLICIT)
    assert md["role"] == "admin"                   # org role 상속


@pytest.mark.anyio
async def test_flag_on_switch_target_param_wins_over_last_project():
    """flag on + project_id param(switch target) 우선 — 저장된 last_project_id보다 명시 param 우선."""
    from app.routers.auth import _build_app_metadata

    user = _user(last_project_id=PID_OLD)          # 옛 값
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=_explicit_helper_execs(ORG_A, "member", "member"))
    seen = {}

    async def _hpa(_s, _uid, pid, _org):
        seen["pid"] = pid
        return True

    with patch("app.routers.auth.settings.build_app_metadata_defallback", True), \
         patch("app.routers.auth.has_project_access", new=_hpa), \
         patch("app.routers.auth._user_projects_claim", new=AsyncMock(return_value=[])):
        md = await _build_app_metadata(user, session, project_id=PID_TARGET)

    assert seen["pid"] == PID_TARGET               # param이 last_project_id보다 우선
    assert md["project_id"] == str(PID_TARGET)


@pytest.mark.anyio
async def test_flag_on_inaccessible_explicit_falls_through_to_legacy():
    """flag on + 명시 pid가 has_project_access 없음 → 명시존중 skip, 기존 추측 경로로 폴스루."""
    from app.routers.auth import _build_app_metadata

    user = _user(last_project_id=PID_EXPLICIT, last_org_id=ORG_A)
    # 폴스루 후 기존 경로: q1(last_project team_member, org scope)=None, q2(fallback ASC)=None,
    # 그 뒤 org_id+member None 분기 → om_role. first_accessible/_user_projects_claim은 patch.
    q1 = MagicMock(); q1.scalar_one_or_none.return_value = None
    q2 = MagicMock(); q2.scalar_one_or_none.return_value = None
    om_role = MagicMock(); om_role.scalar_one_or_none.return_value = "member"
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[q1, q2, om_role])

    with patch("app.routers.auth.settings.build_app_metadata_defallback", True), \
         patch("app.routers.auth.has_project_access", new=AsyncMock(return_value=False)), \
         patch("app.routers.auth.first_accessible_project_id", new=AsyncMock(return_value=None)), \
         patch("app.routers.auth._user_projects_claim", new=AsyncMock(return_value=[])):
        md = await _build_app_metadata(user, session, org_id=ORG_A)

    # 명시존중 안 함 → 기존 org-scope 해소(접근 프로젝트 0 → project_id="")
    assert md["project_id"] == ""


@pytest.mark.anyio
async def test_flag_off_skips_explicit_branch_legacy_behavior():
    """flag off(기본) → 명시존중 분기 통째 skip. has_project_access 호출 0 + 기존 추측 거동 유지."""
    from app.routers.auth import _build_app_metadata

    user = _user(last_project_id=PID_EXPLICIT, last_org_id=ORG_A)
    q1 = MagicMock(); q1.scalar_one_or_none.return_value = None
    q2 = MagicMock(); q2.scalar_one_or_none.return_value = None
    om_role = MagicMock(); om_role.scalar_one_or_none.return_value = "member"
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[q1, q2, om_role])
    hpa = AsyncMock(return_value=True)

    with patch("app.routers.auth.settings.build_app_metadata_defallback", False), \
         patch("app.routers.auth.has_project_access", new=hpa), \
         patch("app.routers.auth.first_accessible_project_id", new=AsyncMock(return_value=None)), \
         patch("app.routers.auth._user_projects_claim", new=AsyncMock(return_value=[])):
        md = await _build_app_metadata(user, session, org_id=ORG_A)

    hpa.assert_not_awaited()                        # flag off → 명시존중 분기 미진입
    assert md["project_id"] == ""                   # 기존 org-scope 거동
