import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, field_validator

from app.models.dependency import DEP_TYPES, ITEM_TYPES


class DependencyCreate(BaseModel):
    from_id: uuid.UUID
    to_id: uuid.UUID
    dep_type: str
    item_type: str

    @field_validator("dep_type")
    @classmethod
    def validate_dep_type(cls, v: str) -> str:
        if v not in DEP_TYPES:
            raise ValueError(f"dep_type must be one of {sorted(DEP_TYPES)}")
        return v

    @field_validator("item_type")
    @classmethod
    def validate_item_type(cls, v: str) -> str:
        if v not in ITEM_TYPES:
            raise ValueError(f"item_type must be one of {sorted(ITEM_TYPES)}")
        return v


class DependencyUpdate(BaseModel):
    """story #2258 AC3: 대기 해제 조건(dep_type) «수정» — 삭제 후 생성이 아니라 같은 행을 UPDATE해
    id/created_at을 보존한다(감사 기록이 「수정」으로 남아야 함)."""
    dep_type: str

    @field_validator("dep_type")
    @classmethod
    def validate_dep_type(cls, v: str) -> str:
        if v not in DEP_TYPES:
            raise ValueError(f"dep_type must be one of {sorted(DEP_TYPES)}")
        return v


class DependencyResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    from_id: uuid.UUID
    to_id: uuid.UUID
    dep_type: str
    item_type: str
    created_at: datetime


class DependencyGraphResponse(BaseModel):
    item_type: str
    nodes: list[uuid.UUID]
    edges: list[dict]
