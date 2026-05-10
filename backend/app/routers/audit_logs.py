import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_verified_org_id
from app.dependencies.database import get_db
from app.repositories.audit import AuditLogRepository
from app.schemas.audit import AuditLogResponse

router = APIRouter(prefix="/api/v2/audit-logs", tags=["audit-logs"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> AuditLogRepository:
    return AuditLogRepository(session, org_id)


@router.get("", response_model=list[AuditLogResponse])
async def list_audit_logs(
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = Query(default=None),
    repo: AuditLogRepository = Depends(_get_repo),
) -> list[AuditLogResponse]:
    items = await repo.list(limit=limit, cursor=cursor)
    return [AuditLogResponse.model_validate(i) for i in items]
