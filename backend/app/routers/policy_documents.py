import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_verified_org_id
from app.dependencies.database import get_db
from app.models.policy_document import PolicyDocument
from app.schemas.policy_document import PolicyDocumentResponse

router = APIRouter(prefix="/api/v2/policy-documents", tags=["policy-documents"])


@router.get("", response_model=list[PolicyDocumentResponse])
async def list_policy_documents(
    project_id: uuid.UUID = Query(...),
    sprint_id: uuid.UUID | None = Query(default=None),
    q: str | None = Query(default=None),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> list[PolicyDocumentResponse]:
    stmt = select(PolicyDocument).where(
        PolicyDocument.org_id == org_id,
        PolicyDocument.project_id == project_id,
        PolicyDocument.deleted_at.is_(None),
    )
    if sprint_id is not None:
        stmt = stmt.where(PolicyDocument.sprint_id == sprint_id)
    if q:
        search = f"%{q}%"
        stmt = stmt.where(
            or_(PolicyDocument.title.ilike(search), PolicyDocument.content.ilike(search))
        )
    stmt = stmt.order_by(PolicyDocument.updated_at.desc())
    result = await session.execute(stmt)
    docs = result.scalars().all()
    return [PolicyDocumentResponse.model_validate(d) for d in docs]
