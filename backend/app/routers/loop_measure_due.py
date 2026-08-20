"""story #2845(loop-closure P2) — /api/v2/loop-measure-due 라우터.

읽기전용 큐 하나뿐(GET /queue) — claim은 신규 엔드포인트 0(§AC⑤, 페드루 PO 판정
2026-08-20): 기존 PATCH /hypotheses/{id}(owner_member_id)·PATCH /goals/{id}(assignee_id)가
이미 그 authz 하에 claim 역할을 한다. dismiss 없음(§AC④) — 큐 소거는 실 판정(가설
resolve·goal outcome)뿐, 별도 액션을 만들면 §4 반증설계가 경계한 위조 채널이 된다.
"""
import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_verified_org_id
from app.dependencies.database import get_read_db
from app.services.loop_measure_due import list_measure_due_queue

router = APIRouter(prefix="/api/v2/loop-measure-due", tags=["loop-measure-due", "Work"])


@router.get("/queue")
async def get_measure_due_queue(
    project_id: uuid.UUID | None = Query(default=None),
    unclaimed_only: bool = Query(default=False),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    session: AsyncSession = Depends(get_read_db),
) -> dict:
    return await list_measure_due_queue(
        session, org_id,
        project_id=project_id, unclaimed_only=unclaimed_only, limit=limit, offset=offset,
    )
