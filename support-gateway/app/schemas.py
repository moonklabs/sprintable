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
    created_at: datetime


class MessageExchangeResponse(BaseModel):
    """story #3261 — customer 메시지 저장 + 그 턴의 agent 응답을 한 번에 준다(v1: 동기 왕복,
    스트리밍/SSE는 story #2 위젯 셸 스코프 — 이 계약 위에서 소비한다)."""

    customer_message: MessageResponse
    agent_message: MessageResponse
    escalated: bool
