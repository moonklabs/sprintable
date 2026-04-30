from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class GrantReward(BaseModel):
    project_id: uuid.UUID
    member_id: uuid.UUID
    amount: float
    reason: str
    granted_by: uuid.UUID
    reference_type: str | None = None
    reference_id: uuid.UUID | None = None


class RewardLedgerResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    member_id: uuid.UUID
    granted_by: uuid.UUID | None = None
    amount: float
    currency: str
    reason: str
    reference_type: str | None = None
    reference_id: uuid.UUID | None = None
    created_at: datetime


class BalanceResponse(BaseModel):
    project_id: uuid.UUID
    member_id: uuid.UUID
    balance: float


class LeaderboardEntry(BaseModel):
    member_id: uuid.UUID
    balance: float
