"""story #3354(마케팅자동화·측정, 페드루 PO 확定 2026-09-03) — org 조회수 카운터 관리 API.

GET  /api/v2/organizations/{org_id}/metering-key   — 활성 공개 키 조회(없으면 최초 발급, org 멤버 read).
POST /api/v2/organizations/{org_id}/metering-key/rotate — 재발급(owner/admin write, connectors.py PUT config와 동형 권한 축).
GET  /api/v2/organizations/{org_id}/pageviews       — measure stage/커넥터가 읽는 집계(org 멤버 read).

설정 화면(키 노출 UI)은 story 4180f67f 후속 — 이번 PR은 API만(PO 확定 Q1 답변)."""
from __future__ import annotations

import uuid
from datetime import date as date_type

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.pageview_counter import get_or_create_active_key, get_pageviews, rotate_key
from app.services.project_auth import is_org_owner_or_admin

router = APIRouter(prefix="/api/v2/organizations", tags=["pageview-metering"])


class MeteringKeyResponse(BaseModel):
    public_key: str


class PageviewDayEntry(BaseModel):
    path: str
    day: date_type
    count: int


@router.get("/{org_id}/metering-key", response_model=MeteringKeyResponse)
async def get_metering_key(
    org_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> MeteringKeyResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    public_key = await get_or_create_active_key(db, org_id=org_id)
    return MeteringKeyResponse(public_key=public_key)


@router.post("/{org_id}/metering-key/rotate", response_model=MeteringKeyResponse)
async def rotate_metering_key(
    org_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> MeteringKeyResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    if not await is_org_owner_or_admin(db, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="org owner/admin required to rotate metering key")
    public_key = await rotate_key(db, org_id=org_id)
    return MeteringKeyResponse(public_key=public_key)


@router.get("/{org_id}/pageviews", response_model=list[PageviewDayEntry])
async def list_pageviews(
    org_id: uuid.UUID,
    path: str | None = Query(default=None),
    date_from: date_type | None = Query(default=None, alias="from"),
    date_to: date_type | None = Query(default=None, alias="to"),
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[PageviewDayEntry]:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    rows = await get_pageviews(db, org_id=org_id, path=path, date_from=date_from, date_to=date_to)
    return [PageviewDayEntry(path=r.path, day=r.day, count=r.count) for r in rows]
