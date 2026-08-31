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


class MessageListResponse(BaseModel):
    """story #3261 보완 — GET /sessions/{id}/messages(대화 이력, 위젯 재오픈 시 복원용)."""

    messages: list[MessageResponse]
