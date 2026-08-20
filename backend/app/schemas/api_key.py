from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


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
    # story #2838(PO AC 확定 2026-08-20) — 기본값 제거로 **필수 필드**. 이전엔 생략 가능해
    # "호출자가 안 정함"과 "호출자가 명시적으로 무만료를 원함"이 둘 다 None으로 뭉개져
    # repository 층에서 90일이 몰래 각인됐다(실사고: 유나 세션 침묵). 이제 발급 UI를 포함한
    # 어떤 호출자든 반드시 명시(값 있으면 그 시각, null이면 명시적 무만료)해야 한다 — 값
    # 자체는 여전히 nullable(무만료 표현), 필드 생략만 422로 거부.
    expires_at: datetime | None

    @field_validator("scope")
    @classmethod
    def validate_scope(cls, v: list[str] | None) -> list[str] | None:
        """story #2058 AC4: 이전엔 임의 문자열을 무검증 저장했다(`api_keys.py:82`) — 오타/garbage
        scope가 조용히 저장돼 나중에 `path_allowed_for_scope`에서 전부 거부되는 형태로만 드러났다
        (fail-closed라 악용 벡터는 아니었으나 UX/디버깅 결함). `mcp_toolset.ALL_GROUPS`(agent_
        recruiter.validate_tool_groups와 동일 SSOT 재사용) ∪ 레거시 `read`/`write` 만 허용한다.

        ⚠️ **기존 키 무영향**: 이 검증은 CREATE 시점(이 스키마)에만 적용된다 — rotate_api_key는
        scope를 건드리지 않고(app/routers/api_keys.py) 기존 저장값을 그대로 유지하며, auth 해석
        (`_check_api_key_scope`/`enforce_write_scope`)도 이미 저장된 scope를 그대로 읽을 뿐 재검증
        하지 않는다. 따라서 이미 발급된 키(legacy read/write 포함)는 이 변경으로 깨지지 않는다.
        """
        if v is None:
            return v
        from app.services.mcp_toolset import ALL_GROUPS, _LEGACY_SCOPES

        allowed = set(ALL_GROUPS) | _LEGACY_SCOPES
        unknown = [tok for tok in v if tok not in allowed]
        if unknown:
            raise ValueError(
                f"scope contains unknown token(s): {unknown} (valid: {sorted(allowed)})"
            )
        return v
