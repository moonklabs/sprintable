"""E-STORAGE-SSOT S2: asset registry read API (AC2 queryable·list/search).

scope-guard = HARD AC(D3·산티아고 stand-down 대신): 모든 응답이 요청자 org + 접근 가능 project 로
필터(타 org/project asset 0 노출). project_id 지정 시 has_project_access 검증(IDOR 차단).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.asset import Asset
from app.services.project_auth import accessible_project_ids_in_org, has_project_access

router = APIRouter(prefix="/api/v2/assets", tags=["assets"])


class AssetResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID | None
    folder_id: uuid.UUID | None
    container: str
    object_path: str
    name: str
    content_type: str | None
    size_bytes: int
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime


@router.get("", response_model=list[AssetResponse])
async def list_assets(
    project_id: uuid.UUID | None = Query(None),
    folder_id: uuid.UUID | None = Query(None),
    mime: str | None = Query(None, description="content_type prefix (e.g. 'image/')"),
    q: str | None = Query(None, description="name 부분검색(ILIKE)"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> list[AssetResponse]:
    user_id = uuid.UUID(auth.user_id)
    stmt = select(Asset).where(Asset.org_id == org_id, Asset.deleted_at.is_(None))

    if project_id is not None:
        # HARD scope: 요청자가 이 project 접근권 보유해야(IDOR 차단·까심 적대 프로빙 대상).
        if not await has_project_access(db, user_id, project_id, org_id):
            raise HTTPException(status_code=403, detail="No access to this project")
        stmt = stmt.where(Asset.project_id == project_id)
    else:
        # project 미지정 → 접근 가능 project + org-level(NULL)만(타 project asset 0 노출).
        accessible = await accessible_project_ids_in_org(db, user_id, org_id)
        stmt = stmt.where(
            or_(Asset.project_id.is_(None), Asset.project_id.in_(accessible))
        )

    if folder_id is not None:
        stmt = stmt.where(Asset.folder_id == folder_id)
    if mime:
        stmt = stmt.where(Asset.content_type.ilike(f"{mime}%"))
    if q:
        stmt = stmt.where(Asset.name.ilike(f"%{q}%"))

    stmt = stmt.order_by(Asset.created_at.desc()).limit(limit).offset(offset)
    rows = (await db.execute(stmt)).scalars().all()
    return [AssetResponse.model_validate(r) for r in rows]
