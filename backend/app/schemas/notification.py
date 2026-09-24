from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class NotificationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    user_id: uuid.UUID
    type: str
    title: str
    body: str | None = None
    is_read: bool
    reference_type: str | None = None
    reference_id: uuid.UUID | None = None
    # story #3903(migration 0378, additive) — conversation.mention/conversation.message만
    # 채움(sender_name + 이벤트 발행 메시지면 event_key/payload/refs). FE가 렌더 시점에
    # eventCard 조합·제목 조합 재료로 쓴다. None이면(옛 행·다른 발행 경로) title/body 폴백.
    event: dict[str, Any] | None = None
    created_at: datetime


class NotificationListItem(NotificationResponse):
    """story #4244 — 목록(GET /notifications) 항목: 알림 대상(reference)의 프로젝트와 문서 slug를 더 싣는다(목록 조회 때 배치 해소 · 저장
    안 함 · 옛 행도 채워짐). FE 링크가 현재 프로젝트가 아니라 대상 자기 프로젝트 p를 싣고, 문서 알림이 목록이 아니라 그 문서로 가게 한다.
    조직 단위 대상(team_member) · 해소 불가(삭제됨 · 다른 조직 · 없는 대상)는 None. 표시·링크 전용 — 권한 판정에 쓰지 않는다.
    ORM 속성이 아니라서 NotificationResponse(from_attributes)와 따로 둔다 — 채우는 곳은 목록 라우트 하나뿐."""

    target_project_id: uuid.UUID | None = None
    target_doc_slug: str | None = None


class NotificationSettingResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    member_id: uuid.UUID
    channel: str
    event_type: str
    enabled: bool


class UpsertNotificationSetting(BaseModel):
    channel: str
    event_type: str
    enabled: bool = True


