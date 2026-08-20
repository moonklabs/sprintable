from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class HumanApiKeyResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    member_id: uuid.UUID
    name: str | None = None
    key_prefix: str
    expires_at: datetime | None = None
    revoked_at: datetime | None = None
    last_used_at: datetime | None = None
    created_at: datetime


class HumanApiKeyCreatedResponse(HumanApiKeyResponse):
    api_key: str


class CreateHumanApiKeyRequest(BaseModel):
    name: str | None = None
    # story #2839(#2838 사람 키 판) — 기본값 없음(필수 필드). null은 여전히 유효(명시적
    # 무만료), "필드 자체를 안 보냄"만 422 — 침묵 90일 각인 경로를 구조로 차단.
    expires_at: datetime | None
