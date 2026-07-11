import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
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
    auth: AuthContext = Depends(get_current_user),
) -> list[PolicyDocumentResponse]:
    # E-SECURITY SEC HIGH paydown round1(#2050 ratchet baseline 상환): org_id는 검증하나
    # caller의 project_id 접근권 검증이 없어 같은 org 다른 project의 정책문서 본문(content)까지
    # ILIKE 검색으로 노출됐다(오늘 R~EE와 동형 근본). resource-actual project_id(쿼리파라미터
    # 자체가 조회 대상이라 body-claimed 개념 없음 — 직접 검증).
    from app.services.project_auth import has_project_access
    if not await has_project_access(session, uuid.UUID(auth.user_id), project_id, org_id):
        raise HTTPException(status_code=404, detail="Project not found")

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
