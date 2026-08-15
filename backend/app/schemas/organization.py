from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, field_validator


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
    created_at: datetime
    updated_at: datetime


class MyOrganizationResponse(BaseModel):
    """내 Organization 목록 조회 응답 — role 포함."""

    id: uuid.UUID
    name: str
    slug: str
    plan: str
    role: str


class UpdateOrganization(BaseModel):
    name: str | None = None
    # story 139d2405(S-slug-infra): workspace rename — 형식/예약어/유일성은 라우터에서(DB 조회 필요).
    slug: str | None = None


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
