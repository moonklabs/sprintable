"""GET /api/v2/usage — org별 사용량 미터 조회.

story #2394: mockups.py에서 분리했다 — 이 엔드포인트/UsageMeter 모델은 mockups 도메인
전용이 아니다(meter_type CHECK가 허용하는 값은 app.models.usage_meter.ALLOWED_METER_TYPES
참고, 'mockups'는 그중에 없다). mockups.py를 통째로 지우면서 이것까지 같이 지우면
무관한 기능을 스코프 밖에서 없애는 것이라 별도 파일로 옮겨 살려뒀다.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.usage_meter import UsageMeter
from app.schemas.usage import UsageMeterOut

router = APIRouter(prefix="/api/v2", tags=["usage", "Work"])


def _ok(data: object, status: int = 200) -> JSONResponse:
    return JSONResponse({"data": data, "error": None, "meta": None}, status_code=status)


def _err(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse({"data": None, "error": {"code": code, "message": message}, "meta": None}, status_code=status)


def _get_org_id(auth: AuthContext) -> uuid.UUID | None:
    meta = auth.claims.get("app_metadata", {})
    o = meta.get("org_id")
    return uuid.UUID(str(o)) if o else None


@router.get("/usage")
async def get_usage_meters(
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    org_id = _get_org_id(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)

    now = datetime.now(timezone.utc)
    period_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    result = await session.execute(
        select(UsageMeter.meter_type, UsageMeter.current_value, UsageMeter.limit_value, UsageMeter.period_start, UsageMeter.period_end)
        .where(UsageMeter.org_id == org_id, UsageMeter.period_start >= period_start)
        .order_by(UsageMeter.meter_type)
    )
    rows = [UsageMeterOut.model_validate(r).model_dump(mode="json") for r in result.all()]
    return _ok(rows)
