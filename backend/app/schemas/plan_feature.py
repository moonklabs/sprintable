import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class PlanFeatureResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    code: str
    name: str
    tier: str
    description: str | None
    is_active: bool
    rate_limit_per_min: int | None
    created_at: datetime
