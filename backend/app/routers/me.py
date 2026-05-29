import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_, select, text
from sqlalchemy.orm import joinedload
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.project import OrgMember
from app.models.team import TeamMember
from app.models.user import User
from app.schemas.me import MeResponse, UpdateMe

router = APIRouter(prefix="/api/v2/me", tags=["me"])


@router.get("", response_model=MeResponse)
async def get_me(
    member_id: uuid.UUID | None = Query(default=None),
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> MeResponse:
    uid = uuid.UUID(auth.user_id)
    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))

    if member_id:
        where_clause = TeamMember.id == member_id
    elif is_api_key:
        # API key 인증: auth.user_id = TeamMember.id
        where_clause = TeamMember.id == uid
    else:
        # JWT 인증: auth.user_id = user.id = TeamMember.user_id
        # app_metadata.project_id로 멀티프로젝트 유저 분기 필수
        project_id_str = auth.claims.get("app_metadata", {}).get("project_id")
        if project_id_str:
            try:
                project_id = uuid.UUID(project_id_str)
                where_clause = (TeamMember.user_id == uid) & (TeamMember.project_id == project_id)
            except (ValueError, AttributeError):
                where_clause = TeamMember.user_id == uid
        else:
            where_clause = TeamMember.user_id == uid

    result = await session.execute(
        select(TeamMember)
        .options(joinedload(TeamMember.project))
        .where(where_clause)
    )
    member = result.scalars().first()

    if member is None and not is_api_key and not member_id:
        # fallback: org_members 기반 응답 — human TM 없는 org-members-only 환경 (E-ENTITY-CLEANUP S5 이후)
        org_id_str = auth.claims.get("app_metadata", {}).get("org_id")
        project_id_str = auth.claims.get("app_metadata", {}).get("project_id")
        if org_id_str:
            om_result = await session.execute(
                select(OrgMember).where(
                    OrgMember.org_id == uuid.UUID(org_id_str),
                    OrgMember.user_id == uid,
                    OrgMember.deleted_at.is_(None),
                )
            )
            org_member = om_result.scalar_one_or_none()
            if org_member:
                user_result = await session.execute(select(User).where(User.id == uid))
                user = user_result.scalar_one_or_none()
                name = user.email if user else str(uid)
                try:
                    proj_id = uuid.UUID(project_id_str) if project_id_str else org_member.org_id
                except (ValueError, AttributeError):
                    proj_id = org_member.org_id
                return MeResponse(
                    id=org_member.id,
                    org_id=org_member.org_id,
                    project_id=proj_id,
                    user_id=uid,
                    name=name,
                    type="human",
                    role=org_member.role,
                    is_active=True,
                    has_password=bool(user.hashed_password) if user else None,
                )

    if member is None:
        raise HTTPException(status_code=404, detail="Member not found")

    data = MeResponse.model_validate(member)
    data.project_name = member.project.name if member.project else None
    data.user_id = member.user_id

    if not is_api_key and member.user_id:
        user_result = await session.execute(select(User).where(User.id == member.user_id))
        user = user_result.scalar_one_or_none()
        if user:
            data.has_password = bool(user.hashed_password)

    # S-MBR-03: org owner/admin → effective role 상속. /me role이 JWT role과 일치하도록.
    if not is_api_key and member.user_id:
        _ROLE_RANK: dict[str, int] = {"owner": 4, "admin": 3, "manager": 2, "member": 1}
        org_role_result = await session.execute(
            select(OrgMember.role).where(
                OrgMember.org_id == member.org_id,
                OrgMember.user_id == member.user_id,
                OrgMember.deleted_at.is_(None),
            )
        )
        org_role = org_role_result.scalar_one_or_none()
        if org_role and _ROLE_RANK.get(org_role, 0) > _ROLE_RANK.get(data.role, 0):
            data = data.model_copy(update={"role": org_role})

    return data


@router.get("/memberships")
async def get_my_memberships(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> list[dict]:
    """현재 사용자가 접근할 수 있는 프로젝트 목록 (스위처 소스).

    S-MBR-FIX: TeamMember 기반 ∪ ProjectAccess grant 기반 ∪ owner/admin org 전체.
    members.py list_members grant 패턴(S-MBR-10) 정합.
    """
    current_org_id: str | None = auth.claims.get("app_metadata", {}).get("org_id")
    # uuid.UUID 객체로 바인딩:
    # - ::uuid 캐스트: asyncpg text()에서 :param::uuid가 syntax error 유발
    # - :param IS NULL: asyncpg가 타입 추론 불가 → AmbiguousParameterError
    # 해결: uuid.UUID 객체로 바인딩 + IS NULL 체크는 CAST(:org_id AS uuid) 함수형 사용
    user_id_param = uuid.UUID(auth.user_id)
    org_id_param: uuid.UUID | None = uuid.UUID(current_org_id) if current_org_id else None

    rows = await session.execute(
        text(
            """
            SELECT DISTINCT p.id::text AS project_id, p.name AS project_name
            FROM projects p
            WHERE p.deleted_at IS NULL
              AND (CAST(:org_id AS uuid) IS NULL OR p.org_id = :org_id)
              AND (
                -- 1. TeamMember 직접 등록 (기존)
                EXISTS (
                    SELECT 1 FROM team_members tm
                    WHERE tm.project_id = p.id
                      AND (tm.id = :user_id OR tm.user_id = :user_id)
                      AND tm.is_active = true
                      AND tm.type = 'human'
                )
                -- 2. ProjectAccess grant (S-MBR-10, members.py 패턴 정합)
                OR EXISTS (
                    SELECT 1 FROM project_access pa
                    JOIN org_members om ON pa.org_member_id = om.id
                    WHERE pa.project_id = p.id
                      AND om.user_id = :user_id
                      AND om.deleted_at IS NULL
                      AND pa.permission = 'granted'
                      AND (CAST(:org_id AS uuid) IS NULL OR om.org_id = :org_id)
                )
                -- 3. owner/admin은 grant 없이도 org 전체 (AC2, S-MBR-03 정합)
                OR EXISTS (
                    SELECT 1 FROM org_members om
                    WHERE om.user_id = :user_id
                      AND om.deleted_at IS NULL
                      AND om.role IN ('owner', 'admin')
                      AND (CAST(:org_id AS uuid) IS NULL OR om.org_id = :org_id)
                      AND p.org_id = om.org_id
                )
              )
            ORDER BY project_name
            """
        ),
        {"user_id": user_id_param, "org_id": org_id_param},
    )
    return [
        {"projectId": row.project_id, "projectName": row.project_name}
        for row in rows
    ]


@router.patch("", response_model=MeResponse)
async def update_me(
    member_id: uuid.UUID = Query(...),
    body: UpdateMe = ...,
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> MeResponse:
    result = await session.execute(
        select(TeamMember).where(TeamMember.id == member_id)
    )
    member = result.scalar_one_or_none()
    if member is None:
        raise HTTPException(status_code=404, detail="Member not found")
    member.name = body.name
    await session.flush()
    await session.refresh(member)
    return MeResponse.model_validate(member)
