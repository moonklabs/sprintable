"""story #2268(D단계, E-CONNECT — "판단 칸"). AC(오르테가, 2026-07-29, 스레드 7256d5cc):
pull 전용 — 「물으면 준다」, push 금지. 자세한 배경은 `app/models/judgment.py`·
`app/services/judgment_core.py` 모듈 docstring 참조.

⛔이 판이 못 잡는 것(AC⑦, 명시 선언): progress.txt를 실제로 지우는 것은 이 판의 몫이 아니다
— 이 스토리는 판단/철회를 저장·조회하는 자리만 세운다. 판정 기준("철회를 다시 주장하지
않는가")은 이 API 자체로는 못 잰다 — 그건 **다음 세션**에서 이 API를 실제로 pull해 쓰는
에이전트의 행동으로만 관측 가능하다.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.judgment_core import DEFAULT_ACTIVE_LIMIT, InvalidJudgmentError, create_judgment, list_judgments
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/v2/judgments", tags=["judgments", "Work"])


class CreateJudgmentRequest(BaseModel):
    scope: str
    work_item_ids: list[uuid.UUID] = []
    kind: str
    target_id: uuid.UUID | None = None
    method: str | None = None
    statement: str


class JudgmentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    scope: str
    work_item_ids: list[uuid.UUID]
    kind: str
    target_id: uuid.UUID | None
    method: str | None
    statement: str
    created_by: uuid.UUID
    created_at: datetime
    # story #2308 후속: 이 원소를 target으로 삼는 correction id들(list_judgments 전용 —
    # POST 응답에선 항상 []. 한 목록만 읽어도 "이건 정정됐다"가 보이게, active·corrections
    # 양쪽 다 이 필드를 갖는다).
    correction_ids: list[uuid.UUID] = []


class JudgmentListMeta(BaseModel):
    scope: str | None
    active_capped: bool
    active_cap_basis: str
    active_omitted_count: int


class JudgmentListResponse(BaseModel):
    corrections: list[JudgmentResponse]
    active: list[JudgmentResponse]
    meta: JudgmentListMeta


@router.post("", response_model=JudgmentResponse, status_code=201)
async def create_judgment_endpoint(
    body: CreateJudgmentRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> Any:
    from app.services.member_resolver import resolve_member

    caller = await resolve_member(auth, org_id, session)
    try:
        judgment = await create_judgment(
            session,
            org_id=org_id,
            scope=body.scope,
            work_item_ids=body.work_item_ids,
            kind=body.kind,
            target_id=body.target_id,
            method=body.method,
            statement=body.statement,
            created_by=caller.id,
        )
    except InvalidJudgmentError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    await session.commit()
    return judgment


@router.get("", response_model=JudgmentListResponse)
async def list_judgments_endpoint(
    work_item_id: uuid.UUID | None = Query(default=None),
    method: str | None = Query(default=None),
    scope: str | None = Query(default=None),
    limit: int = Query(default=DEFAULT_ACTIVE_LIMIT, ge=1, le=200),
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> Any:
    return await list_judgments(
        session, org_id=org_id, work_item_id=work_item_id, method=method, scope=scope, limit=limit,
    )
