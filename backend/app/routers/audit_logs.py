import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.repositories.audit import AuditLogRepository
from app.schemas.audit import AuditLogResponse

router = APIRouter(prefix="/api/v2/audit-logs", tags=["audit-logs"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> AuditLogRepository:
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id") or x_org_id
    if not org_id_str:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="org_id required")
    return AuditLogRepository(session, uuid.UUID(str(org_id_str)))


@router.get("", response_model=list[AuditLogResponse])
async def list_audit_logs(
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = Query(default=None),
    repo: AuditLogRepository = Depends(_get_repo),
) -> list[AuditLogResponse]:
    items = await repo.list(limit=limit, cursor=cursor)
    return [AuditLogResponse.model_validate(i) for i in items]
