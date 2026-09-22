"""story #3823(UX-v3·오늘·BE 1, 페드루 PO 確定 2026-09-13) — ``GET /api/v2/today``.

UI/UX v3 첫 화면 「오늘」(시안 #3817 v3-1b·낱말 표 doc ux-v3-vocabulary-and-desktop-
axes)의 4구역(needs_me·agent_progress·published_today·usage)을 호출 1로. 응답에
사용자 문자열 0 — enum 코드·이름·제목만(낱말은 FE가 [UX-v3] 낱말 표로 매핑).
집계 로직 본체는 ``app.services.today_service`` — 이 라우터는 얇은 스키마+위임뿐
(gates.py/command_center.py의 기존 read 함수를 재사용, 이 카드는 그 두 파일을
손대지 않는다)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services import today_service

router = APIRouter(prefix="/api/v2/today", tags=["today", "Work"])


class TodayWorkItem(BaseModel):
    type: str
    id: uuid.UUID
    title: str


class TodayActor(BaseModel):
    id: uuid.UUID
    name: str


class NeedsMeItem(BaseModel):
    kind: Literal["approval", "signature", "answer"]
    risk: Literal["low", "high"]
    source: Literal["gate", "hitl", "workflow_step"]
    source_id: str
    work_item: TodayWorkItem
    requested_by: TodayActor | None = None
    reason: str | None = None
    created_at: datetime
    actions: list[str]
    # story #3828(UX-v3·대화·BE 1) — 이 work_item을 태그한 가장 최근 대화(있으면).
    # 없으면 null(그 일을 얘기한 대화가 아직 없다는 정직한 사실 — 지어내지 않는다).
    conversation_id: uuid.UUID | None = None
    # story #3965(페드루 PO CHANGES 소형, 2026-09-17) — source="workflow_step" 항목만
    # 채워진다(gate_id는 WorkflowLineStepApproval.gate_id 그대로, S9 parallel gate
    # 대표 Gate). FE가 이 값 없이는 POST /gates/{id}/approvers/{approval_id}/decision을
    # 한 콜로 못 부른다(별도 조회 없이 needs_me 응답만으로 액션 완결). gate/hitl 소스는
    # null(그 개념 자체가 없음 — 지어내지 않는다).
    gate_id: uuid.UUID | None = None


class AgentRunCancelState(BaseModel):
    """story #3961 — 「정지」 액션의 화면 상태. state는 순수 파생값(agent_runs.status/
    cancel_requested_at으로 읽기 시점 계산, agent_runs.py::_effective_cancel_outcome과
    동일 판정 — 두 곳이 갈리지 않는다). 낱말은 PO 확定: unacknowledged도 실패가 아니다."""
    requested_at: datetime
    reason: str | None = None
    state: str  # "requested" | "acknowledged" | "unacknowledged"


class AgentProgressItem(BaseModel):
    run_id: uuid.UUID
    agent: TodayActor
    work_item: TodayWorkItem | None = None
    status: str
    current_step: str | None = None
    started_at: datetime
    # story #3828 — 이 실행을 촉발한 대화(agent_runs.conversation_id). 없으면 null.
    conversation_id: uuid.UUID | None = None
    # story #3961 — 중단 요청 中/ack/미응답 상태. 요청된 적 없으면 null(지어내지 않는다).
    cancel: AgentRunCancelState | None = None


class CompletedTodayItem(BaseModel):
    """story #3833 — 오늘 끝난 위임 1건."""
    run_id: uuid.UUID
    agent: TodayActor
    work_item: TodayWorkItem | None = None
    status: str
    result_summary: str | None = None
    finished_at: datetime
    conversation_id: uuid.UUID | None = None


class PublishedByChannel(BaseModel):
    channel_kind: str
    count: int


class PublishedToday(BaseModel):
    count: int
    by_channel: list[PublishedByChannel]
    since: datetime


class PlatformUsageItem(BaseModel):
    connection_id: uuid.UUID
    channel_kind: str
    used: int
    limit: int
    reset_at: datetime


class AdSpendUsage(BaseModel):
    # story #3498 계열 합류 前까지는 항상 measured=False(0으로 채우지 않는다 —
    # 「미측정」과 「측정했더니 0」을 구분하는 [UX-v3] 낱말 표 규칙의 BE측 반영).
    measured: bool = False


class UsageSection(BaseModel):
    platform: list[PlatformUsageItem]
    ad_spend: AdSpendUsage


class LandedToday(BaseModel):
    """story #3959(3954 그라운딩 doc 처방) — 오늘 done 전이 카운트. story_activities
    실측(actor_id 있는 전이만 남는 행 — 근사 없음, 그 배제 자체가 계약)."""
    count: int
    since: datetime


class QaPassedToday(BaseModel):
    """오늘 승인된 게이트 카운트 — gates.resolved_at 실측(근사 불요)."""
    count: int
    since: datetime


class OpenDefects(BaseModel):
    # story #3959 — verdict(source="qa") 테이블은 있으나 이를 채우는 POST /capture-review
    # 실 호출처가 0(cron·webhook·스크립트 전무) — 지금 count를 내면 거짓 0이 된다.
    # AdSpendUsage와 동일 관례: measured=False 고정, count=None(가짜 0 금지).
    count: int | None = None
    measured: bool = False


class TodayResponse(BaseModel):
    needs_me: list[NeedsMeItem]
    needs_me_count: int
    agent_progress: list[AgentProgressItem]
    completed_today: list[CompletedTodayItem]
    published_today: PublishedToday
    usage: UsageSection
    landed_today: LandedToday
    qa_passed_today: QaPassedToday
    open_defects: OpenDefects


@router.get("", response_model=TodayResponse)
async def get_today(
    tz: str = Query(default="UTC", description="IANA timezone name for the published_today boundary."),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> TodayResponse:
    snapshot = await today_service.build_today_snapshot(session, org_id=org_id, auth=auth, tz=tz)
    return TodayResponse.model_validate(snapshot)
