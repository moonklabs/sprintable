"""story #2728(P0·과금) — platform_settings **공개 API**. GET(read-only)만 노출.

release_notes(app/routers/release_notes.py)와 동일 원칙 — write는 공개 API에 없다(고객이
직접 못 바꾸는 플랫폼 전역 값). mutation은 sprintable-admin/internal-api(require_operator)
전용."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_current_user
from app.dependencies.database import get_db
from app.services.platform_settings import get_platform_settings

router = APIRouter(prefix="/api/v2/platform-settings", tags=["billing"])


class PlatformSettingsResponse(BaseModel):
    billing_price_public: bool
    billing_checkout_enabled: bool


@router.get("", response_model=PlatformSettingsResponse)
async def get_platform_settings_endpoint(
    session: AsyncSession = Depends(get_db),
    _auth=Depends(get_current_user),
) -> PlatformSettingsResponse:
    settings = await get_platform_settings(session)
    return PlatformSettingsResponse(
        billing_price_public=settings.billing_price_public,
        billing_checkout_enabled=settings.billing_checkout_enabled,
    )
