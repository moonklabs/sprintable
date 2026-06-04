from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ApiKeyResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    # E-MEMBER-SSOT AC3-5 ③: team_member_id는 deprecated(canonical 식별자는 members.id 미러 = ApiKey.member_id).
    # 레거시 호환 위해 컬럼·필드 dual 유지(DDL 변경 없음). 신규 소비자는 member 신원해소(resolve)를 사용.
    team_member_id: uuid.UUID = Field(
        deprecated=True,
        description="DEPRECATED(AC3-5 ③): canonical 식별자는 members.id. 레거시 호환용 dual 유지.",
    )
    key_prefix: str
    scope: list[str] | None = None
    expires_at: datetime | None = None
    revoked_at: datetime | None = None
    last_used_at: datetime | None = None
    created_at: datetime


class ApiKeyCreatedResponse(ApiKeyResponse):
    api_key: str


class RotateApiKeyRequest(BaseModel):
    api_key_id: uuid.UUID


class CreateApiKeyRequest(BaseModel):
    scope: list[str] | None = None
    expires_at: datetime | None = None
