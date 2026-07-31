"""story #2268(E-CONNECT, C-10) — GET /api/v2/session-context. 배경은
`app/services/session_context_core.py` 모듈 docstring 참조.

⛔이름 주의(PO 지시, 2026-07-29): `get_loop_context`/`loops.py`와 헷갈리지 않는다 — 그건
E-LOOP-LEDGER의 `LoopRun`(가설/실험 실행 단위) 유사과거 Context Pack이고, 이 라우터는
세션 연속성(진행 중인 내 일 + 판단/정정 + 최근 활동)을 준다 — 둘은 서로 다른 개념이다.

pull 전용(judgment_core와 동일 원칙, story #2268 AC 자체가 요구) — 세션 시작 시 에이전트가
직접 물어서 받는다, push 없음.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.routers.judgments import JudgmentListResponse
from app.schemas.dashboard import StoryItem, TaskItem
from app.services.dashboard_core import MemberNotFoundError
from app.services.session_context_core import DEFAULT_RECENT_ACTIVITY_LIMIT, get_session_context

router = APIRouter(prefix="/api/v2/session-context", tags=["session-context", "Work"])


class ActivityItem(BaseModel):
    id: uuid.UUID
    action: str
    actor_id: uuid.UUID | None
    actor_type: str
    created_at: datetime
    context: dict


class RecentActivityForItem(BaseModel):
    items: list[ActivityItem]
    # ⛔사실 그대로(비율 아님, PO 판정 2026-07-29) — "12건 중 8건"이 아니라 "4건은 안 실렸다".
    omitted_count: int


class SessionContextResponse(BaseModel):
    my_stories: list[StoryItem]
    my_tasks: list[TaskItem]
    judgments_by_work_item: dict[str, JudgmentListResponse]
    # ⛔None = "since를 안 줘서 안 물어봤다"(AC4 — 모름), {} = "물어봤는데 전 항목 0건이었다".
    # 이 둘을 같은 값으로 섞지 않는다.
    recent_activity_since: datetime | None
    recent_activity_by_work_item: dict[str, RecentActivityForItem] | None


@router.get("", response_model=SessionContextResponse)
async def get_session_context_endpoint(
    member_id: uuid.UUID = Query(...),
    project_id: uuid.UUID | None = Query(default=None),
    since: datetime | None = Query(
        default=None,
        description="이 시각 이후 활동만 포함(AC4 — 생략하면 recent_activity 축 전체가 null, 빈 배열이 아니다)",
    ),
    activity_limit: int = Query(default=DEFAULT_RECENT_ACTIVITY_LIMIT, ge=1, le=100),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
) -> Any:
    try:
        return await get_session_context(
            session, org_id=org_id, member_id=member_id, project_id=project_id,
            since=since, activity_limit=activity_limit,
        )
    except MemberNotFoundError as e:
        raise HTTPException(status_code=404, detail="Member not found or inactive") from e
