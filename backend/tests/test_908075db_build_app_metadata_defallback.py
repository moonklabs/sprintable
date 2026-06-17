"""908075db 단계1+2: _build_app_metadata de-fallback (flag-gated).

단계1: flag on이면 명시 의도(switch target project_id ∥ 저장 last_project_id)에 has_project_access
(35a0691e grant-aware) 있으면 가장-오래된-team_member 추측 안 타고 그 project 존중.

단계2(flag on): ① 추측 fallback(가장 오래된 team_member) 제거 → deterministic first_accessible로
해소. ② _build_app_metadata in-function last_project_id/last_org_id mutation 제거(순수) → login
호출부가 _persist_resolved_context로 해소 결과 영속(책임 이관).

flag off(기본)면 단계1·2 모두 skip → 기존 거동 100% 유지(회귀 0). 실험중이라 dev 잔류·flag-on
관측 통과 후 머지.
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
async def test_flag_on_inaccessible_explicit_deterministic_no_guess():
    """908075db 단계2: flag on + 명시 pid 접근불가 → **추측 안 타고** deterministic first_accessible로
    해소. in-function user mutation 없음(불변·호출부 책임)."""
    from app.routers.auth import _build_app_metadata

    PID_DET = uuid.uuid4()
    user = _user(last_project_id=PID_OLD, last_org_id=ORG_A)
    # 단계2: 추측(가장 오래된 team_member) execute 없음 → q_360(last_project team_member None) + om_role 2회만.
    q_360 = MagicMock(); q_360.scalar_one_or_none.return_value = None
    q_om = MagicMock(); q_om.scalar_one_or_none.return_value = "member"
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[q_360, q_om])

    with patch("app.routers.auth.settings.build_app_metadata_defallback", True), \
         patch("app.routers.auth.has_project_access", new=AsyncMock(return_value=False)), \
         patch("app.routers.auth.first_accessible_project_id", new=AsyncMock(return_value=PID_DET)), \
         patch("app.routers.auth._user_projects_claim", new=AsyncMock(return_value=[])):
        md = await _build_app_metadata(user, session, org_id=ORG_A)

    assert md["project_id"] == str(PID_DET)         # 추측 아닌 first_accessible(deterministic)
    assert md["role"] == "member"
    assert session.execute.await_count == 2         # 추측 쿼리 미발생(360 + om_role만)
    assert user.last_project_id == PID_OLD          # 단계2: 함수가 mutate 안 함(호출부 책임)


def test_persist_resolved_context_helper():
    """908075db 단계2: 호출부가 md로 last_project_id/last_org_id 영속. project_id 비면 None(stale 제거),
    org_id 비면 last_org_id 유지."""
    from app.routers.auth import _persist_resolved_context

    PID = uuid.uuid4(); OID = uuid.uuid4()
    u = _user(last_project_id=PID_OLD, last_org_id=ORG_A)
    _persist_resolved_context(u, {"project_id": str(PID), "org_id": str(OID)})
    assert u.last_project_id == PID
    assert u.last_org_id == OID

    u2 = _user(last_project_id=PID_OLD, last_org_id=ORG_A)
    _persist_resolved_context(u2, {"project_id": "", "org_id": ""})
    assert u2.last_project_id is None               # 접근 project 0 → stale 제거
    assert u2.last_org_id == ORG_A                  # 빈 org_id → 유지


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
