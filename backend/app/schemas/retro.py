import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, field_validator

from app.schemas.validators import is_blank

# story #2413 AC3(PO 지시, 2026-08-02) — "회고제목"처럼 이름이 비어 있는 회고를 만들 수 없게
# 서버가 거부한다. 실측(dev, MCP list_retro_sessions): 6건 중 blank title 0건 — "회고제목"은
# blank가 아니라 "지우지 않은 기본값"이라 이 가드로는 못 잡는다(별건, FE placeholder 축). 그래도
# 앞으로의 진짜 빈 제목은 이 가드가 막는다.
_BLANK_TITLE_MSG = "title은 비어 있을 수 없습니다"


class CreateSession(BaseModel):
    project_id: uuid.UUID
    org_id: uuid.UUID
    title: str
    sprint_id: uuid.UUID | None = None
    created_by: uuid.UUID | None = None

    @field_validator("title")
    @classmethod
    def _reject_blank_title(cls, v: str) -> str:
        if is_blank(v):
            raise ValueError(_BLANK_TITLE_MSG)
        return v


class GetOrCreateBySprint(BaseModel):
    """story #2281 AC3ⓐ — sprint_id 기준 get-or-create. project_id는 안 받는다 —
    sprint 자체가 project를 이미 알아 caller가 넘긴 값과 어긋날 여지가 없다."""
    sprint_id: uuid.UUID
    title: str | None = None

    @field_validator("title")
    @classmethod
    def _reject_blank_title(cls, v: str | None) -> str | None:
        # None(생략)은 통과 — 라우터(get_or_create_session_by_sprint)가 `body.title or
        # f"{sprint.title} 회고"`로 자동 제목을 붙인다. 예전엔 ""도 이 `or`로 조용히
        # 자동제목이 됐지만, story #2413 AC3는 "명시적으로 보낸 빈 값"을 거부하라는
        # 것이라 여기서 먼저 막는다(자동생성 경로는 None 생략일 때만).
        if v is not None and is_blank(v):
            raise ValueError(_BLANK_TITLE_MSG)
        return v


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
    measure_after: datetime | None = None
    # story 5feac498: sprints.py `SprintHypothesisItem`(story fbf1c14b)과 동일 shape — FE에
    # hypothesis 상세 페이지가 없어(API 프록시만 존재) href 추측은 죽은 링크였다(그 story의
    # PO crux로 None 확정). 두 embed 경로가 동일 shape이어야 FE가 이걸 소비하고 별도
    # /sprints/{id}/hypotheses 재조회를 없앨 수 있다.
    href: str | None = None


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


class AdoptNextHypothesis(BaseModel):
    """story 4b87d3a6 — FE `handleAdoptRecommendation`가 `{...rec, statement}`(rec=
    NextHypothesisCandidate 런타임 객체 — TS 타입엔 `id`가 없지만 실제 응답엔 있어 spread로
    실려온다)를 body로 보낸다. candidate_id를 path가 아니라 이 body의 `id`로 받는다(FE
    무변경). `statement`는 사람이 편집했을 수 있는 override — 없으면 서버 저장 candidate의
    statement를 그대로 쓴다(§3.7.1 HITL: "확정은 당신이" — 편집을 무시하면 사람의 편집이
    조용히 버려지는 위반이라 이 필드를 실반영해야 한다)."""

    model_config = ConfigDict(extra="ignore")

    id: uuid.UUID
    statement: str | None = None


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
