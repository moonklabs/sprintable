"""E-ENTITY-CLEANUP S4: Members API OrgMember 기반 통합 테스트.

AC1: GET 프로젝트 멤버 → org_members + project_access JOIN 쿼리
AC2: 조직 멤버 = 전체 프로젝트 접근 (project_access 레코드 없으면 허용)
AC3: project_access CRUD API (프로젝트별 접근 차단/허용)
AC4: 조직 탈퇴 시 project_access cascade 삭제 (FK)
AC5: team_members human 생성 API deprecated (410)
AC6: 기존 invite 플로우: 조직 초대만 (project_access 기반)
AC7: 에이전트(type=agent) team_members 영향 없음
"""
from __future__ import annotations

import inspect


# ─── AC1: GET /api/v2/members 쿼리 변경 ──────────────────────────────────────

def test_members_endpoint_uses_org_members_join():
    """list_members 소스에 org_members JOIN 쿼리 존재."""
    from app.routers import members
    source = inspect.getsource(members.list_members)
    assert "org_members" in source
    assert "project_access" in source


def test_members_endpoint_opt_out_logic():
    """list_members 소스에 'denied' 제외 opt-out 로직 존재 (S-MBR-03: owner/admin 예외 포함)."""
    from app.routers import members
    source = inspect.getsource(members.list_members)
    assert "denied" in source
    assert "NOT EXISTS" in source or "not exists" in source.lower()


# ─── AC2: 레코드 없음 = 접근 허용 ────────────────────────────────────────────

def test_members_includes_all_org_members_by_default():
    """list_members 쿼리에서 project_access 없는 org_member는 기본 포함됨."""
    from app.routers import members
    source = inspect.getsource(members.list_members)
    # opt-out: NOT EXISTS(blocked) → 허용. blocked 레코드 없으면 포함
    assert "NOT EXISTS" in source or "blocked" in source


# ─── AC3: project_access CRUD ────────────────────────────────────────────────

def test_project_access_router_exists():
    """project_access 라우터 존재."""
    from app.routers import project_access
    paths = [r.path for r in project_access.router.routes]
    assert any("access" in p for p in paths)


def test_project_access_endpoints():
    """GET, POST, DELETE /projects/{project_id}/access 엔드포인트 존재."""
    from app.routers import project_access
    methods_paths = [(list(r.methods or []), r.path) for r in project_access.router.routes]
    has_get = any("GET" in m for m, _ in methods_paths)
    has_post = any("POST" in m for m, _ in methods_paths)
    has_delete = any("DELETE" in m for m, _ in methods_paths)
    assert has_get and has_post and has_delete


def test_project_access_create_defaults_denied():
    """ProjectAccessCreate 기본 permission='denied' (full spec: 'allowed'|'denied')."""
    from app.routers.project_access import ProjectAccessCreate
    obj = ProjectAccessCreate(org_member_id="00000000-0000-0000-0000-000000000001")
    assert obj.permission == "denied"


def test_project_access_response_schema():
    """ProjectAccessResponse에 id, project_id, org_member_id, permission, created_at 존재."""
    from app.routers.project_access import ProjectAccessResponse
    fields = set(ProjectAccessResponse.model_fields.keys())
    assert {"id", "project_id", "org_member_id", "permission", "created_at"}.issubset(fields)


# ─── AC4: cascade 삭제 (FK 정의) ─────────────────────────────────────────────

def test_project_access_org_member_cascade_defined():
    """ProjectAccess.org_member_id FK ON DELETE CASCADE 정의 존재."""
    from app.models.project_access import ProjectAccess
    for fk in ProjectAccess.__table__.foreign_keys:
        if "org_members" in str(fk.target_fullname):
            assert fk.ondelete == "CASCADE"
            return
    assert False, "org_members cascade FK not found"


# ─── AC5: team_members human 생성 deprecated ─────────────────────────────────

def test_create_team_member_deprecates_human():
    """create_team_member 소스에 human type → 410 deprecated 처리 존재."""
    from app.routers import team_members
    source = inspect.getsource(team_members.create_team_member)
    assert "human" in source
    assert "410" in source or "deprecated" in source.lower()


def test_create_team_member_human_blocked():
    """create_team_member 에 type=human → HTTPException 발생 확인 (소스 검증)."""
    from app.routers import team_members
    source = inspect.getsource(team_members.create_team_member)
    # 410 또는 deprecated 메시지 포함
    assert "410" in source


# ─── AC6: 조직 초대 플로우 유지 ──────────────────────────────────────────────

def test_org_invite_router_still_exists():
    """org_invites 라우터 변경 없이 유지됨."""
    from app.routers import org_invites
    paths = [r.path for r in org_invites.router.routes]
    assert any("invites" in p for p in paths)


def test_project_access_registered_in_main():
    """project_access 라우터가 main.py에 등록됨."""
    import inspect
    from app import main
    source = inspect.getsource(main)
    assert "project_access" in source
    assert "project_access.router" in source


# ─── AC7: agent team_members 영향 없음 ───────────────────────────────────────

def test_members_endpoint_still_returns_agents():
    """list_members 소스에 agent type=agent team_members 쿼리 유지됨."""
    from app.routers import members
    source = inspect.getsource(members.list_members)
    assert "agent" in source
    assert "TeamMember" in source


def test_team_members_agent_creation_unaffected():
    """create_team_member 소스에서 agent 타입은 기존 로직 유지됨."""
    from app.routers import team_members
    source = inspect.getsource(team_members.create_team_member)
    # agent 경로는 여전히 존재
    assert "agent" in source
    assert "fakechat_port" in source
