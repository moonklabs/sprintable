"""verdict 조회 전용 라우터 — 기록은 record_verdict() 내부 서비스만.

POST 엔드포인트 없음: 에이전트 자기 verdict 수동기록 차단.
"""
import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.schemas.verdict import VerdictResponse
from app.services.verdict_recorder import get_verdicts_by_participation

router = APIRouter(prefix="/api/v2/verdicts", tags=["verdicts"])


@router.get("", response_model=list[VerdictResponse])
async def list_verdicts(
    participation_id: uuid.UUID = Query(...),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> list[VerdictResponse]:
    verdicts = await get_verdicts_by_participation(session, org_id, participation_id)
    return [VerdictResponse.model_validate(v) for v in verdicts]
