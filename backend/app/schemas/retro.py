import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class CreateSession(BaseModel):
    project_id: uuid.UUID
    org_id: uuid.UUID
    title: str
    sprint_id: uuid.UUID | None = None
    created_by: uuid.UUID | None = None


class ItemResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    session_id: uuid.UUID
    author_id: uuid.UUID | None = None
    category: str
    text: str
    vote_count: int
    created_at: datetime
    # B4: 요청자(canonical member id)가 이 item에 투표했는지 — get_session에서만 명시 계산
    # (계산 필드라 ORM에서 자동 채워지지 않음). 다른 생성/응답 경로는 default False.
    voted_by_me: bool = False
    # B2: 'group' phase 병합. parent_item_id는 이 item이 병합돼 들어간 대상(child일 때만 non-null
    # — 단, child는 get_session/export 응답에서 top-level만 노출하는 정책상 실제론 잘 안 보임).
    parent_item_id: uuid.UUID | None = None
    # parent item일 때 그 아래 병합된 child item id 목록(get_session에서만 명시 계산).
    grouped_item_ids: list[uuid.UUID] = []


class ActionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    session_id: uuid.UUID
    assignee_id: uuid.UUID | None = None
    title: str
    status: str
    created_at: datetime


class RetroHypothesisItem(BaseModel):
    """dc861e44 §5 — sprint 링크 가설(story 1 `hypothesis_sprint_links.sprint_id`) 평탄화.
    N>=0 동일 렌더 — 0개/측정중만이어도 graceful(FE "아직 측정 중")."""

    id: uuid.UUID
    statement: str
    status: str  # verified|falsified|measuring|killed|... (색/라벨은 FE·SOUL-LOCK)
    metric: str | None = None
    target: float | None = None
    direction: str | None = None
    actual: float | None = None  # outcome_result.actual, 미확정이면 None(측정중)
    href: str


class SynthesisLearnedItem(BaseModel):
    text: str
    source: str


class Synthesis(BaseModel):
    """L2 종합 — on-demand·overwrite 저장(PO 결). null이면 미생성(FE CTA)."""

    learned: list[SynthesisLearnedItem]
    generated_at: datetime
    source: str = "ai_draft"


class NextHypothesisCandidate(BaseModel):
    """L3 다음가설 추천 — `HypothesisDraftResponse` 형 재사용(§5 계약). id는 story 3
    "채택" 액션이 참조할 안정 키."""

    id: uuid.UUID
    statement: str
    metric_definition: dict[str, Any]
    measure_after: datetime
    confidence: float | None = None
    rationale: str
    requires_confirmation: bool = True
    # ecc531ce — 채택되면 생성된 hypothesis id(idempotency 겸용 마커). None=미채택.
    adopted_hypothesis_id: uuid.UUID | None = None


class SessionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    org_id: uuid.UUID
    sprint_id: uuid.UUID | None = None
    created_by: uuid.UUID | None = None
    title: str
    phase: str
    created_at: datetime
    updated_at: datetime
    items: list[ItemResponse] = []
    actions: list[ActionResponse] = []
    # dc861e44 §5 — additive+nullable. hypotheses는 sprint_id 없으면 항상 []·회귀 0.
    hypotheses: list[RetroHypothesisItem] = []
    synthesis: Synthesis | None = None
    next_hypotheses: list[NextHypothesisCandidate] | None = None


class SessionListResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    org_id: uuid.UUID
    sprint_id: uuid.UUID | None = None
    title: str
    phase: str
    created_at: datetime
    updated_at: datetime


class PhaseTransition(BaseModel):
    phase: str


class CreateItem(BaseModel):
    category: str  # good | bad | improve
    text: str
    author_id: uuid.UUID | None = None


class GroupItem(BaseModel):
    parent_item_id: uuid.UUID


class CreateAction(BaseModel):
    title: str
    assignee_id: uuid.UUID | None = None


class UpdateAction(BaseModel):
    title: str | None = None
    assignee_id: uuid.UUID | None = None
    status: str | None = None


class VoteResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    item_id: uuid.UUID
    voter_id: uuid.UUID
    created_at: datetime
