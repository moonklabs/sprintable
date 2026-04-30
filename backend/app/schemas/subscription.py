from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class SubscriptionStatusResponse(BaseModel):
    status: str
    tier: str
    grace_until: datetime | None = None


class AccountDeleteResponse(BaseModel):
    ok: bool
    grace_period_days: int = 30
