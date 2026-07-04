import uuid

from pydantic import BaseModel


class ContextPackOutcome(BaseModel):
    """P1-S12: hypothesis가 verified/falsified로 해소됐을 때만 populate(S9 OutcomeBadge 매핑)."""
    hypothesis_status: str
    metric: str | None = None
    actual: float | None = None
    target: float | None = None
    direction: str | None = None


class ContextPackSearchResult(BaseModel):
    """P1-S6: 유사도 검색 결과 1건. entity_type/entity_id는 embeddings의 폴리모픽 참조를 그대로 노출
    (호출자가 S7 Context Pack 조립 시 해당 엔티티를 직접 로드).

    a353e88d(PO 결 2026-07-03) — sprint-open L1 선례 UI가 "결과"까지 한 응답으로 보여주도록
    additive+nullable 확장(서버 배치 enrich, N+1 금지 — §6 절대: 회수 스코프[WHERE 절] 무변경,
    결과 shape에 필드만 얹음). entity_type=="hypothesis"일 때만 populate; loop 등 다른 엔티티는
    항상 None. hypothesis_status는 outcome 유무와 무관하게 항상 노출(measuring/proposed 등
    outcome 없는 상태도 표시), outcome은 실제 verified/falsified로 채점된 경우만(ContextPackOutcome
    재사용 — P1-S12와 동일 형상)."""
    entity_type: str
    entity_id: uuid.UUID
    embedding_text: str
    similarity: float
    hypothesis_status: str | None = None
    outcome: ContextPackOutcome | None = None


class ContextPackDecisionSide(BaseModel):
    """P1-S12: decision.chosen/rejected[] 항목 1건(doc fbe5923e §3)."""
    label: str
    reason: str | None = None


class ContextPackDecision(BaseModel):
    """P1-S12: entity_type=='loop'일 때만 populate — chosen 1건+top rejected(대표 1건)."""
    chosen: ContextPackDecisionSide | None = None
    rejected: list[ContextPackDecisionSide] = []


class ContextPackItem(BaseModel):
    """P1-S12: GET /loops/{id}/context-pack 응답 1건(doc fbe5923e §3, 유나 S13 목업 확정 계약)."""
    entity_type: str  # "loop" | "hypothesis" | "decision"(내부 loop_artifact를 FE 명명으로 매핑)
    entity_id: uuid.UUID
    similarity: float
    goal: str
    decision: ContextPackDecision | None = None
    outcome: ContextPackOutcome | None = None
    # hypothesis는 nullable — 미르코 FE 라우트 실측(2026-07-02): apps/web에 독립 hypothesis 상세
    # 페이지 없음(HypothesesSection은 /epics/[id] 임베드뿐 + epic_ids 다대다라 /epics 치환도 모호).
    # broken link 주느니 null(FE가 링크 생략 처리) — 진짜 딥링크는 별도 follow-up.
    href: str | None


class ContextPackResponse(BaseModel):
    """P1-S12: 최상위 응답 — items(similarity-desc)+embed_available(임베딩 불가 상태 구분).

    S26: synthesis(L2 학습 종합, str|None) 추가 — items 회수 근거로만 gen-LLM(S25)이 증류.
    items 0건이거나 gen-LLM 미가용이면 null(퇴화 없음 — items(L1)는 그대로 표시).

    S27: recommendation(L3 능동 추천, str|None) 추가 — synthesis(L2)+새 loop의 goal/hypothesis를
    gen-LLM으로 처방. synthesis가 null이면(근거 자체가 없음) recommendation도 항상 null(L1/L2
    무손상 — 과잉 처방 금지).

    S28(유나 BE↔FE 계약, 2026-07-02): *_confidence("high"|"medium"|"low"|None)는 LLM이 산출한
    확신도를 구조화 필드로 노출(텍스트 hedge와 별개 — FE 배지 렌더용). evidence_count는
    items 수로 결정론적 산출(LLM 산출물 아님) — "과거 N건 기준" FE 표시 소스."""
    items: list[ContextPackItem]
    embed_available: bool
    synthesis: str | None = None
    synthesis_confidence: str | None = None
    recommendation: str | None = None
    recommendation_confidence: str | None = None
    evidence_count: int = 0
