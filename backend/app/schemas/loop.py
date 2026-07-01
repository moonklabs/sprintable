"""E-LOOP-LEDGER S3: /api/v2/loops DTO. 블루프린트 §3/§6.

created_by_member_id는 절대 client 입력 필드가 아니다 — 서버가 resolve_member로 해소한다
(hypotheses.created_by_member_id와 동일 컨벤션, identity 위조 방지)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class LoopCreate(BaseModel):
    project_id: uuid.UUID
    title: str
    # S1 스키마는 nullable — API 레벨 필수화는 S14(P2) 스코프.
    hypothesis_id: uuid.UUID | None = None
    parent_loop_id: uuid.UUID | None = None
    recipe_slug: str | None = None
    goal_tags: list[str] = []


class LoopResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    parent_loop_id: uuid.UUID | None = None
    hypothesis_id: uuid.UUID | None = None
    brief_doc_id: uuid.UUID | None = None
    decision_gate_id: uuid.UUID | None = None
    chosen_artifact_id: uuid.UUID | None = None
    recipe_slug: str | None = None
    title: str
    goal_tags: list[str]
    status: str
    outcome_snapshot: dict[str, Any] | None = None
    outcome_attributed_at: datetime | None = None
    created_by_member_id: uuid.UUID
    created_at: datetime
    updated_at: datetime


class LoopArtifactCreate(BaseModel):
    """S4: variant 후보 등록. decision 필드는 의도적으로 없다 — 서버가 'pending' 고정
    (chosen/rejected는 S5 게이트 전용 엔드포인트, client가 직접 전이 불가)."""

    variant_group: str
    variant_label: str
    asset_id: uuid.UUID
    generation_metadata: dict[str, Any] = {}


class LoopArtifactResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    loop_id: uuid.UUID
    asset_id: uuid.UUID
    variant_group: str
    variant_label: str
    decision: str
    choose_reason: str | None = None
    rejection_reason: str | None = None
    generation_metadata: dict[str, Any]
    sort_order: int
    created_by_member_id: uuid.UUID
    created_at: datetime
    updated_at: datetime


class LoopArtifactVariantGroup(BaseModel):
    variant_group: str
    artifacts: list[LoopArtifactResponse]
