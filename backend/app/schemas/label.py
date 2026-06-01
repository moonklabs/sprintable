import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, field_validator

from app.models.label import ITEM_TYPES


class LabelCreate(BaseModel):
    name: str
    color: str | None = None


class LabelUpdate(BaseModel):
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
