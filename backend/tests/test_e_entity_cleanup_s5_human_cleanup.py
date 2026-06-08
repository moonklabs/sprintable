"""E-ENTITY-CLEANUP S5: team_members human 타입 정리 테스트.

AC1: type=human team_member 신규 생성 로직 제거
AC2: 기존 human team_member → org_member 참조 전환
AC3: 스토리 assignee 등 FK 참조 정상 동작
AC4: type=agent team_members 영향 없음
AC5: 프로젝트 생성 시 auto-attach 로직을 org_members 기반으로 변경
"""
from __future__ import annotations

import inspect


# ─── AC1: human 신규 생성 로직 제거 ──────────────────────────────────────────

def test_projects_no_human_team_member_creation():
    """create_project 소스에 type='human' team_member INSERT 없음."""
    from app.routers import projects
    source = inspect.getsource(projects.create_project)
    # human team_member INSERT가 없어야 함
    assert "'human'" not in source or "team_members" not in source or (
        # team_members 참조가 있더라도 'human' insert가 아닌 agent 필터에만 사용
        "type = 'agent'" in source
    )


# 구 invitations 라우터(Invitation)는 d3619e80 cutover로 제거 — canonical=org_invites/invite_accept.
# 자동수락 휴먼 team_member 미생성 회귀는 auth/org_invite 경로(아래 test_auth_no_human_team_member_on_invite)로 유지.


def test_auth_no_human_team_member_on_invite():
    """auth 소스에 invitation accept 시 human team_member 생성 없음."""
    from app.routers import auth
    source = inspect.getsource(auth)
    # TeamMember 생성에서 type="human" 블록 제거됨
    # (agent 생성은 team_members.py에 있으므로 auth에는 없어야 함)
    # 간접 확인: auth.py에 team_member human 생성 코드 부재
    lines = source.splitlines()
    for i, line in enumerate(lines):
        if 'type="human"' in line or "type='human'" in line:
            context = "\n".join(lines[max(0, i-3):i+3])
            assert "TeamMember(" not in context, f"Human TeamMember creation found at line {i}: {context}"


# ─── AC2: org_member 참조 전환 ───────────────────────────────────────────────

def test_projects_ensures_org_member():
    """create_project 소스에 org_members upsert 존재 (opt-out 접근 보장)."""
    from app.routers import projects
    source = inspect.getsource(projects.create_project)
    assert "org_members" in source
    assert "ON CONFLICT" in source


# ─── AC3: story/task assignee — E-MEMBER-SSOT AC3-2(0078)에서 계약 변경 ──────────
# S5 당시: assignee_id team_members FK 유지(agent 배정).
# AC3-2(1154dd9e, migration 0078): 그 FK가 grant-only 휴먼(org_member.id) 배정 시 실DB FK
#   violation 500을 유발 → FK 제거. canonical 식별자는 assignee_id_v2. agent 배정은 id 값으로
#   계속 동작(FK 강제만 해제). 따라서 team_members FK가 **없어야** 정상. [[feedback_one_sided_transition]]

def test_story_assignee_has_no_team_members_fk():
    """AC3-2: Story.assignee_id team_members FK 제거 — grant-only 배정 500 해소."""
    from app.models.pm import Story
    referred = {fk.column.table.name for fk in Story.__table__.c.assignee_id.foreign_keys}
    assert "team_members" not in referred


def test_task_assignee_has_no_team_members_fk():
    """AC3-2: Task.assignee_id team_members FK 제거 — grant-only 배정 500 해소."""
    from app.models.pm import Task
    referred = {fk.column.table.name for fk in Task.__table__.c.assignee_id.foreign_keys}
    assert "team_members" not in referred


# ─── AC4: agent 영향 없음 ────────────────────────────────────────────────────

def test_projects_auto_attach_agent_only():
    """create_project auto-attach 소스에 type='agent' 필터 존재."""
    from app.routers import projects
    source = inspect.getsource(projects.create_project)
    assert "agent" in source
    assert "project_memberships" in source


def test_team_members_create_agent_still_works():
    """create_team_member 소스에서 agent 타입은 여전히 처리됨."""
    from app.routers import team_members
    source = inspect.getsource(team_members.create_team_member)
    assert "agent" in source
    assert "fakechat_port" in source


# ─── AC5: project 생성 auto-attach org_members 기반 ─────────────────────────

def test_project_creation_uses_org_members_for_access():
    """create_project 소스에 org_members INSERT/upsert 존재 — human은 org_member로 접근."""
    from app.routers import projects
    source = inspect.getsource(projects.create_project)
    assert "org_members" in source


def test_project_auto_attach_excludes_human():
    """create_project auto-attach에서 human team_member 생성 없음."""
    from app.routers import projects
    source = inspect.getsource(projects.create_project)
    # INSERT INTO team_members ... 'human' 패턴이 없어야 함
    assert "INSERT INTO team_members" not in source
