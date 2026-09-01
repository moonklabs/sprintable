from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel


class SessionResponse(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    created_at: datetime


class MessageCreateRequest(BaseModel):
    content: str


class MessageResponse(BaseModel):
    id: uuid.UUID
    conversation_id: uuid.UUID
    role: str
    content: str
    created_at: datetime


class MessageExchangeResponse(BaseModel):
    """story #3261 — customer 메시지 저장 + 그 턴의 agent 응답을 한 번에 준다(v1: 동기 왕복,
    스트리밍/SSE는 story #2 위젯 셸 스코프 — 이 계약 위에서 소비한다).

    ⚠️story #3261 보완(2026-08-31, 페드루 PO 실 왕복 실측 지적) — 최초 릴리즈는 agent_message에
    content가 없어 위젯이 답을 볼 방법이 0이었다(응답은 DB엔 저장되는데 클라이언트가 읽을
    경로가 없는 계약 구멍). MessageResponse에 content를 추가해 해소."""

    customer_message: MessageResponse
    agent_message: MessageResponse
    escalated: bool
    # story #3263 AC4 — `escalated`는 이 턴 하나의 순간신호일 뿐, 대화 전체가 지금 사람에게
    # 걸려있는지는 별개 질문이다. escalation_status는 "지금 열려있는 게 하나라도 있는가"로
    # 판정한다(routers/sessions.py::_conversation_escalation_status) — None(한 번도 에스컬
    # 안 됨) | "open" | "resolved".
    escalation_status: str | None


class MessageListResponse(BaseModel):
    """story #3261 보완 — GET /sessions/{id}/messages(대화 이력, 위젯 재오픈 시 복원용).

    story #3263 AC4 — 재오픈 시에도 escalation_status가 살아있어야 한다(무신호 금지). 턴
    단위 `escalated` 배지는 그 순간이 지나면 화면에서 사라지지만, 사람에게 넘어간 사실
    자체는 위젯을 닫았다 열어도 조용히 사라지면 안 된다."""

    messages: list[MessageResponse]
    escalation_status: str | None


class AdminMetricsResponse(BaseModel):
    """story #3264 AC3/AC4 — 어드민 계측 조회. 고객 대화 원문은 절대 안 실린다(집계 숫자만)."""

    window_since: datetime
    org_id: uuid.UUID | None
    total_turns: int
    escalated_turns: int
    resolved_turns: int
    resolution_rate: float | None
    escalation_rate: float | None
    cost_cap_org_daily_usd: float
    cost_cap_org_session_usd: float
