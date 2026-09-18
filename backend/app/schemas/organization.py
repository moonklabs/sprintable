from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


class CreateOrganization(BaseModel):
    name: str
    slug: str
    owner_member_id: uuid.UUID | None = None

    @field_validator("name", "slug")
    @classmethod
    def not_empty(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("must not be empty")
        return stripped


class OrganizationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    slug: str
    plan: str
    # story 46da6450 — IANA 이름, null=미설정(FE는 브라우저 tz 폴백을 그대로 쓴다).
    timezone: str | None = None
    created_at: datetime
    updated_at: datetime


class MyOrganizationResponse(BaseModel):
    """내 Organization 목록 조회 응답 — role 포함."""

    id: uuid.UUID
    name: str
    slug: str
    plan: str
    role: str
    # story 46da6450 — OrganizationResponse.timezone과 동일 의미.
    timezone: str | None = None


class UpdateOrganization(BaseModel):
    name: str | None = None
    # story 139d2405(S-slug-infra): workspace rename — 형식/예약어/유일성은 라우터에서(DB 조회 필요).
    slug: str | None = None
    # story 46da6450 — IANA 이름. 필드 자체를 생략하면 무변경, 명시적으로 null을 보내면
    # 해제(name/slug와 달리 "생략=무변경"과 "null=해제"를 구별해야 하므로 라우터가
    # `"timezone" in body.model_fields_set`로 판정 — None이면 그냥 스킵하는 기존
    # name/slug 패턴을 그대로 쓰면 해제가 영원히 불가능해진다). max_length=64(페드루
    # 리뷰 N1) — 가장 긴 실 IANA 이름도 40자 미만(예: America/Argentina/ComodRivadavia
    # 32자)이라 여유 있게 상한, zoneinfo 검증 前에 극단적으로 긴 문자열을 앞단에서 거른다.
    timezone: str | None = Field(default=None, max_length=64)


class OrgImpactResponse(BaseModel):
    project_count: int
    member_count: int
    has_active_subscription: bool


class DeleteOrganization(BaseModel):
    confirmation: str
    # #2092 AC1/AC3 — 서버가 삭제 직전 자체적으로 영향도(impact)를 재조회한다(클라이언트가
    # "조회에 실패했다"고 주장하는 걸 신뢰하지 않는다 — "금지는 서버가 거부" 축). 그 재조회
    # 자체가 실패했을 때만 이 필드가 의미를 갖는다: False(기본)면 즉시 거부(reason=
    # "impact_unavailable")하고, 사용자가 명시적으로 "확認하지 못한 상태로 삭제합니다"를
    # 인정한 뒤에만(=True) 진행을 허용한다. 영향도 재조회가 정상 성공하면 이 필드 값과
    # 무관하게(True로 와도) 무시 — 그 경우 원래도 override가 필요 없다.
    confirm_without_impact: bool = False
