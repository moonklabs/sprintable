import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, field_validator


class TaskCreate(BaseModel):
    story_id: uuid.UUID
    org_id: uuid.UUID
    title: str
    assignee_id: uuid.UUID | None = None
    status: str = "todo"
    story_points: int | None = None


class TaskUpdate(BaseModel):
    title: str | None = None
    status: str | None = None
    assignee_id: uuid.UUID | None = None
    story_points: int | None = None


class TaskResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    story_id: uuid.UUID
    org_id: uuid.UUID
    assignee_id: uuid.UUID | None = None
    title: str
    status: str
    story_points: int | None = None
    created_at: datetime
    updated_at: datetime

    # E-VERIFY V0-S2(story 3fbd048d): evidence-backed 신호(positive 단방향) — story.has_evidence와
    # 동형(True 또는 None, False 없음). 라우터가 model_validate 前 transient attr로 세팅.
    has_evidence: bool | None = None

    @field_validator("has_evidence", mode="before")
    @classmethod
    def _coerce_has_evidence(cls, v):
        return v if isinstance(v, bool) else None

    # Claimed vs Verified(doc claimed-vs-verified-spec-handoff §3) — story.py와 동형.
    self_reported: bool | None = None
    human_verified: bool | None = None
    human_verified_by: uuid.UUID | None = None
    human_verified_at: datetime | None = None

    @field_validator("self_reported", "human_verified", mode="before")
    @classmethod
    def _coerce_evidence_bool_signal(cls, v):
        return v if isinstance(v, bool) else None

    @field_validator("human_verified_by", mode="before")
    @classmethod
    def _coerce_human_verified_by(cls, v):
        return v if isinstance(v, uuid.UUID) else None

    @field_validator("human_verified_at", mode="before")
    @classmethod
    def _coerce_human_verified_at(cls, v):
        return v if isinstance(v, datetime) else None
