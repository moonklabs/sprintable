"""EE Billing API — Polar 연동 라우터.

이 라우터는 EE_ENABLED 환경에서만 main.py에 등록됨.
OSS 빌드(is_ee_enabled=False)에서는 import되지 않아 403 방어 불필요.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db

router = APIRouter(tags=["billing-ee"])


def _require_ee() -> None:
    """EE 비활성화 환경에서 호출 시 403 반환 (방어적 guard)."""
    if not settings.is_ee_enabled:
        raise HTTPException(status_code=403, detail="Enterprise Edition not enabled")


@router.get("/status")
async def get_billing_status(
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
    _ee: None = Depends(_require_ee),
) -> dict:
    """현재 Org의 Billing 상태 조회 (Polar 연동 예정)."""
    return {"org_id": str(org_id), "plan": "pro", "status": "active", "provider": "polar"}


@router.get("/plans")
async def list_billing_plans(
    _auth: AuthContext = Depends(get_current_user),
    _ee: None = Depends(_require_ee),
) -> list[dict]:
    """사용 가능한 Billing 플랜 목록 (Polar 연동 예정)."""
    return [
        {"id": "free", "name": "Free", "price": 0},
        {"id": "pro", "name": "Pro", "price": 29},
        {"id": "enterprise", "name": "Enterprise", "price": None},
    ]


@router.post("/checkout")
async def create_checkout_session(
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
    _ee: None = Depends(_require_ee),
) -> dict:
    """Polar 결제 세션 생성 (Polar SDK 연동 예정)."""
    return {"checkout_url": None, "message": "Polar SDK integration pending"}
