"""E-CAGE-REFEREE P1: 데이터 오염 dry-run 조회 라우터.

GET 전용 — 마킹/변경 없음. 실제 마킹은 PATCH /stories/{id} is_excluded=true 로.
"""
import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.exclusion_report import generate_exclusion_report

router = APIRouter(prefix="/api/v2/exclusion", tags=["exclusion"])


@router.get("/dry-run")
async def exclusion_dry_run(
    project_id: uuid.UUID | None = Query(default=None),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> dict:
    return await generate_exclusion_report(session, org_id, project_id)
