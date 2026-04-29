import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.repositories.org_member import OrgMemberRepository
from app.schemas.org_member import OrgMemberCreate, OrgMemberResponse, OrgMemberUpdate

router = APIRouter(prefix="/api/v2/org-members", tags=["org-members"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> OrgMemberRepository:
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id") or x_org_id
    if not org_id_str:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="org_id required (X-Org-Id header or JWT app_metadata)",
        )
    return OrgMemberRepository(session, uuid.UUID(str(org_id_str)))


@router.get("", response_model=list[OrgMemberResponse])
async def list_org_members(
    repo: OrgMemberRepository = Depends(_get_repo),
) -> list[OrgMemberResponse]:
    members = await repo.list()
    return [OrgMemberResponse.model_validate(m) for m in members]


@router.post("", response_model=OrgMemberResponse, status_code=201)
async def create_org_member(
    body: OrgMemberCreate,
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> OrgMemberResponse:
    repo = OrgMemberRepository(session, body.org_id)
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


@router.patch("/{id}", response_model=OrgMemberResponse)
async def update_org_member(
    id: uuid.UUID,
    body: OrgMemberUpdate,
    repo: OrgMemberRepository = Depends(_get_repo),
) -> OrgMemberResponse:
    from app.schemas.org_member import ORG_ROLES
    if body.role and body.role not in ORG_ROLES:
        raise HTTPException(status_code=400, detail=f"role must be one of: {', '.join(ORG_ROLES)}")
    data = body.model_dump(exclude_unset=True)
    member = await repo.update(id, **data)
    if member is None:
        raise HTTPException(status_code=404, detail="Org member not found")
    return OrgMemberResponse.model_validate(member)


@router.delete("/{id}", status_code=200)
async def delete_org_member(
    id: uuid.UUID,
    repo: OrgMemberRepository = Depends(_get_repo),
) -> dict:
    ok = await repo.soft_delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Org member not found")
    return {"ok": True}
