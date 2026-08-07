import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.project import Project
from app.models.team import TeamMember
from app.schemas.current_project import CurrentProjectResponse, SetCurrentProject
from app.services.member_resolver import assert_caller_is_member
from app.services.project_auth import has_project_access

router = APIRouter(prefix="/api/v2/current-project", tags=["current-project", "Organization"])


@router.get("", response_model=CurrentProjectResponse)
async def get_current_project(
    member_id: uuid.UUID = Query(...),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> CurrentProjectResponse:
    """S20(authz-coverage 스캐너 발견 — S19 Phase C서 no-op으로 skip 판단했던 그 오라클):
    member_id로 임의 member의 project_id/org_id/project_name을 caller-ownership 검증 없이
    조회할 수 있었다(membership-existence 오라클). self-scope 추가.

    story #2217(2026-08-07) 근본수정 — TeamMember row가 없으면(owner-floor 휴먼, #2216: 명시
    grant 없이 has_project_access의 admin_branch로만 접근하는 org owner/admin) `org_id`까지
    None으로 버렸다. 그런데 `org_id`는 애초에 TeamMember 조회와 무관하게 이 함수 자신의
    `Depends(get_verified_org_id)`(JWT claims 유래)로 이미 들고 있다 — POST 핸들러가 바로
    아래서 `org_id=org_id`로 정확히 그렇게 쓰는 것과 대칭이 깨져 있었다. `project_id`는 여전히
    None이 맞다(백엔드는 "사용자가 지금 뭘 골랐나"를 모른다 — 그 정본은 FE 전용 쿠키
    `sprintable_current_project_id`다. 안 골랐으면 None이 사실이고, 서버가 project_id를
    지어내면 그게 거짓이 된다 — #2217 AC2/AC3 판단, PO 승인 2026-08-07)."""
    await assert_caller_is_member(member_id, auth, session, org_id)
    tm_r = await session.execute(
        select(TeamMember.project_id, TeamMember.org_id).where(
            TeamMember.id == member_id, TeamMember.is_active.is_(True)
        ).limit(1)
    )
    row = tm_r.first()
    if row is None:
        return CurrentProjectResponse(project_id=None, project_name=None, org_id=org_id)

    proj_r = await session.execute(
        select(Project.name).where(Project.id == row[0])
    )
    project_name = proj_r.scalar_one_or_none()

    return CurrentProjectResponse(
        project_id=row[0],
        project_name=project_name,
        org_id=row[1],
    )


@router.post("", response_model=CurrentProjectResponse)
async def set_current_project(
    body: SetCurrentProject,
    member_id: uuid.UUID = Query(...),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> CurrentProjectResponse:
    """S20(산티아고 재확인 대상 — S19 Phase C서 no-op으로 skip 판단했던 그 오라클을 authz-coverage
    스캐너가 재발견): member_id가 caller 본인인지 검증 없이 임의 member의 project 전환 결과
    (project_name/org_id)를 열람할 수 있었다. self-scope 추가.

    #2216: 프로젝트 접근권 체크를 TeamMember(=team_members뷰, members ⋈ project_access
    INNER JOIN) 단독 조회로 했더니 owner-floor 휴먼(명시 grant 없이 has_project_access의
    admin_branch로만 접근하는 org owner/admin)이 자기 프로젝트를 "고르는" 이 엔드포인트에서
    영구히 403을 맞았다 — #2212가 "프로젝트 못 정하면 org-briefing으로 보내 고르게 한다"고
    고친 그 「고르는」 동작 자체가 벽이었다. has_project_access(project_auth.py, admin_branch
    포함 4-branch SSOT)로 교체 — 새 규칙 발명 0, project_access.py/analytics.py 등 기존
    project-scope 가드와 동일 판정."""
    await assert_caller_is_member(member_id, auth, session, org_id)
    if not await has_project_access(session, uuid.UUID(auth.user_id), body.project_id, org_id):
        raise HTTPException(status_code=403, detail="Project membership not found")

    proj_r = await session.execute(
        select(Project.name).where(Project.id == body.project_id)
    )
    project_name = proj_r.scalar_one_or_none()

    return CurrentProjectResponse(
        project_id=body.project_id,
        project_name=project_name,
        org_id=org_id,
    )
