import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.user import RefreshToken
from app.repositories.org_member import OrgMemberRepository
from app.schemas.org_member import ORG_ROLES, OrgMemberCreate, OrgMemberResponse, OrgMemberUpdate

router = APIRouter(prefix="/api/v2/org-members", tags=["org-members"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> OrgMemberRepository:
    return OrgMemberRepository(session, org_id)


async def _require_admin(
    repo: OrgMemberRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> OrgMemberRepository:
    """DB에서 caller의 OrgMember role 확인 — owner 또는 admin만 통과."""
    caller = await repo.get_by_user(uuid.UUID(auth.user_id))
    if caller is None or caller.role not in ("owner", "admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="org admin 또는 owner 권한 필요",
        )
    return repo


@router.get("", response_model=list[OrgMemberResponse])
async def list_org_members(
    repo: OrgMemberRepository = Depends(_get_repo),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> list[OrgMemberResponse]:
    """org_members + users JOIN — email 포함 응답."""
    result = await session.execute(
        text(
            """
            SELECT om.id, om.org_id, om.user_id, om.role,
                   om.created_at, om.deleted_at,
                   u.email
            FROM org_members om
            LEFT JOIN users u ON u.id = om.user_id
            WHERE om.org_id = :org_id AND om.deleted_at IS NULL
            ORDER BY om.created_at
            """
        ),
        {"org_id": str(org_id)},
    )
    return [
        OrgMemberResponse(
            id=row.id,
            org_id=row.org_id,
            user_id=row.user_id,
            role=row.role,
            created_at=row.created_at,
            deleted_at=row.deleted_at,
            email=row.email,
        )
        for row in result
    ]


@router.post("", response_model=OrgMemberResponse, status_code=201)
async def create_org_member(
    body: OrgMemberCreate,
    repo: OrgMemberRepository = Depends(_require_admin),
) -> OrgMemberResponse:
    if body.role not in ORG_ROLES:
        raise HTTPException(status_code=400, detail=f"role must be one of: {', '.join(ORG_ROLES)}")
    # repo.org_id는 JWT에서 추출됨 — body.org_id 무시 (org_id 조작 방지)
    member = await repo.create(user_id=body.user_id, role=body.role)
    return OrgMemberResponse.model_validate(member)


@router.get("/{id}", response_model=OrgMemberResponse)
async def get_org_member(
    id: uuid.UUID,
    repo: OrgMemberRepository = Depends(_get_repo),
) -> OrgMemberResponse:
    member = await repo.get(id)
    if member is None:
        raise HTTPException(status_code=404, detail="Org member not found")
    return OrgMemberResponse.model_validate(member)


async def _revoke_user_refresh_tokens(session: AsyncSession, user_id: uuid.UUID) -> None:
    """해당 사용자의 refresh token 전량 revoke."""
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(timezone.utc))
    )


@router.patch("/{id}", response_model=OrgMemberResponse)
async def update_org_member(
    id: uuid.UUID,
    body: OrgMemberUpdate,
    repo: OrgMemberRepository = Depends(_require_admin),
) -> OrgMemberResponse:
    if body.role and body.role not in ORG_ROLES:
        raise HTTPException(status_code=400, detail=f"role must be one of: {', '.join(ORG_ROLES)}")
    data = body.model_dump(exclude_unset=True)
    if "role" in data:
        existing = await repo.get(id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Org member not found")
        if existing.role != data["role"]:
            await _revoke_user_refresh_tokens(repo.session, existing.user_id)
    member = await repo.update(id, **data)
    if member is None:
        raise HTTPException(status_code=404, detail="Org member not found")
    await repo.session.commit()
    return OrgMemberResponse.model_validate(member)


@router.get("/{id}/affected-projects")
async def get_affected_projects(
    id: uuid.UUID,
    repo: OrgMemberRepository = Depends(_require_admin),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> list[dict]:
    """해당 org member가 참여 중인 프로젝트 목록 반환 (AC1/AC2/AC3)."""
    from app.models.team import TeamMember
    from app.models.project import Project
    member = await repo.get(id)
    if member is None:
        raise HTTPException(status_code=404, detail="Org member not found")
    result = await session.execute(
        text(
            """
            SELECT DISTINCT p.id AS project_id, p.name AS project_name, tm.role
            FROM team_members tm
            JOIN projects p ON p.id = tm.project_id
            WHERE tm.org_id = :org_id
              AND tm.user_id = :user_id
              AND tm.is_active = true
              AND p.deleted_at IS NULL
            ORDER BY p.name
            """
        ),
        {"org_id": str(org_id), "user_id": str(member.user_id)},
    )
    return [
        {"project_id": str(row.project_id), "project_name": row.project_name, "role": row.role}
        for row in result
    ]


@router.delete("/{id}", status_code=200)
async def delete_org_member(
    id: uuid.UUID,
    repo: OrgMemberRepository = Depends(_require_admin),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    existing = await repo.get(id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Org member not found")
    # AC5: owner guard — owner는 삭제 불가
    if existing.role == "owner":
        raise HTTPException(status_code=403, detail="조직 owner는 삭제할 수 없습니다")
    await _revoke_user_refresh_tokens(repo.session, existing.user_id)
    # cascade — team_members is_active = False
    await session.execute(
        text(
            """
            UPDATE team_members
            SET is_active = false
            WHERE org_id = :org_id AND user_id = :user_id AND is_active = true
            """
        ),
        {"org_id": str(org_id), "user_id": str(existing.user_id)},
    )
    # AC3-4 2-1 dual-write: 뷰가 is_active를 members서 읽으므로 동시 반영(cutover 전 동기).
    await session.execute(
        text(
            "UPDATE members SET is_active = false"
            " WHERE org_id = :org_id AND user_id = :user_id AND is_active = true"
        ),
        {"org_id": str(org_id), "user_id": str(existing.user_id)},
    )
    # S-MBR-10 AC5: project_access grant 레코드 삭제 (soft delete는 FK CASCADE 미트리거)
    await session.execute(
        text("DELETE FROM project_access WHERE org_member_id = :om_id"),
        {"om_id": str(id)},
    )
    ok = await repo.soft_delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Org member not found")
    return {"ok": True}
