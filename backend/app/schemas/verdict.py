import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class VerdictResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    participation_id: uuid.UUID
    source: str
    result: str | None = None
    rounds: int | None = None
    recorded_at: datetime
    created_at: datetime
