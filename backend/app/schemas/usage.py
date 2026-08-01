from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class UsageMeterOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    meter_type: str
    current_value: int
    limit_value: int | None = None
    period_start: datetime
    period_end: datetime | None = None
