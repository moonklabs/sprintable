"""E-CAGE-REFEREE P1: 데이터 오염 dry-run 조회 라우터.

GET 전용 — 마킹/변경 없음. 실제 마킹은 PATCH /stories/{id} is_excluded=true 로.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.exclusion_report import generate_exclusion_report

router = APIRouter(prefix="/api/v2/exclusion", tags=["exclusion", "Trust"])


@router.get("/dry-run")
async def exclusion_dry_run(
    project_id: uuid.UUID | None = Query(default=None),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> dict:
    # story #4350 — caller가 접근 가능한 프로젝트만(SEC-S8). 명시 project_id도 접근 확인(없으면 404 · 존재 비노출).
    from app.services.project_auth import accessible_project_ids_in_org

    accessible = await accessible_project_ids_in_org(session, uuid.UUID(_auth.user_id), org_id)
    if project_id is not None and project_id not in accessible:
        raise HTTPException(status_code=404, detail="Project not found")
    return await generate_exclusion_report(session, org_id, project_id, project_ids=accessible)
