import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, field_validator

from app.models.label import ITEM_TYPES
from app.schemas.not_null_fields import RejectsExplicitNull


class LabelCreate(BaseModel):
    name: str
    color: str | None = None


class LabelUpdate(RejectsExplicitNull):
    # story #4337 — DB 칸이 NOT NULL인 필드: 생략 = 그대로 · 명시 null은 422(예전엔 저장에서 무결성 오류 500).
    NOT_NULL_FIELDS = frozenset({"name"})

    name: str | None = None
    color: str | None = None


class LabelResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    name: str
    color: str | None = None
    created_at: datetime
    updated_at: datetime


class ItemLabelCreate(BaseModel):
    label_id: uuid.UUID
    item_id: uuid.UUID
    item_type: str

    @field_validator("item_type")
    @classmethod
    def validate_item_type(cls, v: str) -> str:
        if v not in ITEM_TYPES:
            raise ValueError(f"item_type must be one of {sorted(ITEM_TYPES)}")
        return v


class ItemLabelResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    label_id: uuid.UUID
    item_id: uuid.UUID
    item_type: str
    created_at: datetime
