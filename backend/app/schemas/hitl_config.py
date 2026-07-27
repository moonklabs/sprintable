import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, field_validator

from app.models.hitl_config import DISPOSITIONS, GATE_TYPES, POSTURES


class OrgGatePolicyCreate(BaseModel):
    posture: str = "balanced"

    @field_validator("posture")
    @classmethod
    def validate_posture(cls, v: str) -> str:
        if v not in POSTURES:
            raise ValueError(f"posture must be one of {sorted(POSTURES)}")
        return v


class OrgGatePolicyResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    posture: str
    created_at: datetime
    updated_at: datetime


class OrgGateOverrideCreate(BaseModel):
    role_id: uuid.UUID
    gate_type: str
    disposition: str

    @field_validator("gate_type")
    @classmethod
    def validate_gate_type(cls, v: str) -> str:
        if v not in GATE_TYPES:
            raise ValueError(f"gate_type must be one of {sorted(GATE_TYPES)}")
        return v

    @field_validator("disposition")
    @classmethod
    def validate_disposition(cls, v: str) -> str:
        if v not in DISPOSITIONS:
            raise ValueError(f"disposition must be one of {sorted(DISPOSITIONS)}")
        return v


class OrgGateOverrideResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    role_id: uuid.UUID
    gate_type: str
    disposition: str
    created_at: datetime


class MemberGateOverrideCreate(BaseModel):
    member_id: uuid.UUID
    gate_type: str
    disposition: str

    @field_validator("gate_type")
    @classmethod
    def validate_gate_type(cls, v: str) -> str:
        if v not in GATE_TYPES:
            raise ValueError(f"gate_type must be one of {sorted(GATE_TYPES)}")
        return v

    @field_validator("disposition")
    @classmethod
    def validate_disposition(cls, v: str) -> str:
        if v not in DISPOSITIONS:
            raise ValueError(f"disposition must be one of {sorted(DISPOSITIONS)}")
        return v


class MemberGateOverrideResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    member_id: uuid.UUID
    gate_type: str
    disposition: str
    created_at: datetime


class ResolveRequest(BaseModel):
    member_id: uuid.UUID
    role_id: uuid.UUID
    gate_type: str


class ResolveResponse(BaseModel):
    disposition: str
    # SID 301ee45d/#2047 AC1: "member_override"|"org_override"|"org_policy"|"system_default" —
    # 이 disposition이 누군가 명시 설정한 값인지 시스템 기본값인지 API 응답에서 바로 보이게 한다.
    source: str
    member_id: uuid.UUID
    role_id: uuid.UUID
    gate_type: str
