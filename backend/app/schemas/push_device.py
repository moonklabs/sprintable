from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator

# Expo push 토큰 포맷: ExponentPushToken[...] 또는 ExpoPushToken[...] (crux §2: 클라 제출값 방어적 검증).
_EXPO_TOKEN_RE = re.compile(r"^Expo(nent)?PushToken\[[^\[\]\s]+\]$")


class RegisterPushDevice(BaseModel):
    """디바이스 등록 요청. member_id 는 body 에 없음 — auth context 서 산출(IDOR: 타 멤버 등록 불가)."""

    expo_push_token: str
    platform: Literal["ios", "android"]
    device_id: str | None = None
    app_version: str | None = None

    @field_validator("expo_push_token")
    @classmethod
    def token_must_be_expo_format(cls, v: str) -> str:
        v = v.strip()
        if not _EXPO_TOKEN_RE.match(v):
            raise ValueError("expo_push_token must be an ExponentPushToken[...] value")
        return v


class PushDeviceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    member_id: uuid.UUID
    expo_push_token: str
    platform: str
    device_id: str | None = None
    app_version: str | None = None
    is_active: bool
    created_at: datetime
    last_seen_at: datetime
