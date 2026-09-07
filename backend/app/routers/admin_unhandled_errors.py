"""story #3672(BE·BFF·FE·관측, 페드루 PO 確定 2026-09-07) — 미처리 500의 서버측
지속 흔적 조회. admin_billing.py와 같은 SA ID-token 인가 게이트(require_admin_operator)
재사용 — 새 인가 축 발명 0."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.admin_auth import AdminOperator, require_admin_operator
from app.dependencies.database import get_db
from app.services.unhandled_error_events import get_unhandled_error_event

router = APIRouter(prefix="/api/v2/admin", tags=["admin"])


@router.get("/unhandled-errors/{error_id}")
async def get_unhandled_error(
    error_id: uuid.UUID,
    operator: AdminOperator = Depends(require_admin_operator),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """AC3 — 응답=저장 컬럼 그대로. 존재하지 않으면 404(지어내지 않는다 — 이
    error_id로 아무것도 못 찾았다는 사실 그대로)."""
    row = await get_unhandled_error_event(db, error_id=error_id)
    if row is None:
        raise HTTPException(status_code=404, detail="unhandled error event not found")
    return {
        "id": str(row.id),
        "occurred_at": row.occurred_at.isoformat(),
        "method": row.method,
        "path": row.path,
        "exception_class": row.exception_class,
        "message": row.message,
        "org_id": str(row.org_id) if row.org_id else None,
        "user_id": str(row.user_id) if row.user_id else None,
        "request_id": row.request_id,
    }
