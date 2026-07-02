import uuid

from pydantic import BaseModel


class ContextPackSearchResult(BaseModel):
    """P1-S6: 유사도 검색 결과 1건. entity_type/entity_id는 embeddings의 폴리모픽 참조를 그대로 노출
    (호출자가 S7 Context Pack 조립 시 해당 엔티티를 직접 로드)."""
    entity_type: str
    entity_id: uuid.UUID
    embedding_text: str
    similarity: float


class ContextPackDecisionSide(BaseModel):
    """P1-S12: decision.chosen/rejected[] 항목 1건(doc fbe5923e §3)."""
    label: str
    reason: str | None = None


class ContextPackDecision(BaseModel):
    """P1-S12: entity_type=='loop'일 때만 populate — chosen 1건+top rejected(대표 1건)."""
    chosen: ContextPackDecisionSide | None = None
    rejected: list[ContextPackDecisionSide] = []


class ContextPackOutcome(BaseModel):
    """P1-S12: hypothesis가 verified/falsified로 해소됐을 때만 populate(S9 OutcomeBadge 매핑)."""
    hypothesis_status: str
    metric: str | None = None
    actual: float | None = None
    target: float | None = None
    direction: str | None = None


class ContextPackItem(BaseModel):
    """P1-S12: GET /loops/{id}/context-pack 응답 1건(doc fbe5923e §3, 유나 S13 목업 확정 계약)."""
    entity_type: str  # "loop" | "hypothesis" | "decision"(내부 loop_artifact를 FE 명명으로 매핑)
    entity_id: uuid.UUID
    similarity: float
    goal: str
    decision: ContextPackDecision | None = None
    outcome: ContextPackOutcome | None = None
    href: str


class ContextPackResponse(BaseModel):
    """P1-S12: 최상위 응답 — items(similarity-desc)+embed_available(임베딩 불가 상태 구분)."""
    items: list[ContextPackItem]
    embed_available: bool
