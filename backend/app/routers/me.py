import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_, select
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

    return data


@router.get("/memberships")
async def get_my_memberships(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> list[dict]:
    current_org_id: str | None = auth.claims.get("app_metadata", {}).get("org_id")
    where_clauses = [
        or_(
            TeamMember.id == uuid.UUID(auth.user_id),
            TeamMember.user_id == uuid.UUID(auth.user_id),
        ),
        TeamMember.is_active.is_(True),
        TeamMember.type == "human",
    ]
    if current_org_id:
        where_clauses.append(TeamMember.org_id == uuid.UUID(current_org_id))
    result = await session.execute(
        select(TeamMember)
        .options(joinedload(TeamMember.project))
        .where(*where_clauses)
        .order_by(TeamMember.created_at)
    )
    members = result.scalars().all()
    return [
        {
            "projectId": str(m.project_id),
            "projectName": m.project.name if m.project else "Untitled Project",
        }
        for m in members
        if m.project_id
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
