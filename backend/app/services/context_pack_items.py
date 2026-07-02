"""E-LOOP-LEDGER P1-S12: Context Pack structured JSON 조립(블루프린트 §2, doc fbe5923e §3).

GET /loops/{id}/context-pack의 데이터 소스 — P1-S7(loop_briefing.py)과 동일한 검색 기전(loop
자신의 title+goal_tags를 embed_client로 동기 임베드→search_similar_embeddings, 자기 자신 제외)을
재사용하되, markdown brief 대신 S13 UI 카드가 바로 렌더할 수 있는 structured items를 반환한다
(markdown은 재파싱이 깨지기 쉬워 재사용 불가 — 검색 로직만 공유, 조립은 독립).

PO crux 확정(2026-07-02): ①정렬=similarity-desc(관련성 우선, hit-first 아님) ②decision 블록은
entity_type=='loop'일 때만(chosen+top rejected 1건, 전부 아님)·나머지는 null ③outcome은
hypothesis_status 기반(loop은 자신의 hypothesis_id를 통해 간접 해소)·verified/falsified일 때만
④embed_available:false = 임베딩 서비스 자체가 불가(빈 결과와 별개 신호).

entity_type 매핑: 내부 embeddings.entity_type의 'loop_artifact'는 응답에서 'decision'으로
노출(S13 UI가 붙이는 명명 — "타입칩(loop/hypothesis/decision)").

href(미르코 FE 라우트 실측 반영, 2026-07-02): loop→/loops/{id}·decision→부모 loop(독립 상세
페이지 없음)·hypothesis→null(apps/web에 독립 hypothesis 상세 페이지가 없어 broken link를
주느니 정직하게 null로 반환 — FE가 링크 생략 처리, 진짜 딥링크는 별도 follow-up 스토리).
"""
from __future__ import annotations

import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hypothesis import Hypothesis
from app.models.loop import LoopArtifact, LoopRun
from app.schemas.context_pack import (
    ContextPackDecision,
    ContextPackDecisionSide,
    ContextPackItem,
    ContextPackOutcome,
    ContextPackResponse,
)

logger = logging.getLogger(__name__)

_SEARCH_LIMIT = 10
_RESOLVED_HYPOTHESIS_STATUSES = frozenset({"verified", "falsified"})
_ENTITY_TYPE_DISPLAY = {"hypothesis": "hypothesis", "loop": "loop", "loop_artifact": "decision"}


async def build_loop_context_pack(
    session: AsyncSession, org_id: uuid.UUID, loop: LoopRun,
) -> ContextPackResponse:
    vector = None
    try:
        from app.services.embedding_client import embed_text
        from app.services.embedding_enqueue import build_loop_embedding_text

        query_text = build_loop_embedding_text(loop.title, loop.goal_tags)
        vector = embed_text(query_text)
    except Exception as exc:
        logger.warning("context-pack items: embed 실패(생략 처리): %s", exc)
        vector = None

    if vector is None:
        return ContextPackResponse(items=[], embed_available=False)

    try:
        from app.services.context_pack_search import search_similar_embeddings

        raw = await search_similar_embeddings(session, org_id, loop.project_id, vector, limit=_SEARCH_LIMIT)
        results = [r for r in raw if not (r.entity_type == "loop" and r.entity_id == loop.id)]
    except Exception as exc:
        logger.warning("context-pack items: 검색 실패(생략 처리): %s", exc)
        return ContextPackResponse(items=[], embed_available=False)

    # search_similar_embeddings는 cosine 거리 ASC(=similarity DESC)로 이미 정렬 — crux ①과 정합.
    items = await _build_items(session, org_id, results)
    return ContextPackResponse(items=items, embed_available=True)


async def _build_items(session: AsyncSession, org_id: uuid.UUID, results: list) -> list[ContextPackItem]:
    if not results:
        return []

    hyp_ids = {r.entity_id for r in results if r.entity_type == "hypothesis"}
    loop_ids = {r.entity_id for r in results if r.entity_type == "loop"}
    artifact_ids = {r.entity_id for r in results if r.entity_type == "loop_artifact"}

    hyp_by_id: dict[uuid.UUID, Hypothesis] = {}
    loop_by_id: dict[uuid.UUID, LoopRun] = {}
    artifact_by_id: dict[uuid.UUID, LoopArtifact] = {}

    if hyp_ids:
        rows = (await session.execute(select(Hypothesis).where(Hypothesis.id.in_(hyp_ids)))).scalars().all()
        hyp_by_id = {h.id: h for h in rows}
    if loop_ids:
        rows = (await session.execute(select(LoopRun).where(LoopRun.id.in_(loop_ids)))).scalars().all()
        loop_by_id = {lp.id: lp for lp in rows}
    if artifact_ids:
        rows = (await session.execute(select(LoopArtifact).where(LoopArtifact.id.in_(artifact_ids)))).scalars().all()
        artifact_by_id = {a.id: a for a in rows}

    # loop 항목의 outcome은 그 loop 자신의 hypothesis_id를 통해 간접 해소 — 배치 재로드.
    linked_hyp_ids = {lp.hypothesis_id for lp in loop_by_id.values() if lp.hypothesis_id is not None}
    linked_hyp_ids -= hyp_by_id.keys()
    if linked_hyp_ids:
        rows = (await session.execute(select(Hypothesis).where(Hypothesis.id.in_(linked_hyp_ids)))).scalars().all()
        hyp_by_id.update({h.id: h for h in rows})

    # loop 항목의 decision(chosen+top rejected)용 artifact 배치 조회.
    decision_artifacts_by_loop: dict[uuid.UUID, list[LoopArtifact]] = {}
    if loop_ids:
        rows = (await session.execute(
            select(LoopArtifact).where(
                LoopArtifact.loop_id.in_(loop_ids),
                LoopArtifact.decision.in_(("chosen", "rejected")),
            )
        )).scalars().all()
        for a in rows:
            decision_artifacts_by_loop.setdefault(a.loop_id, []).append(a)

    items: list[ContextPackItem] = []
    for r in results:
        display_type = _ENTITY_TYPE_DISPLAY[r.entity_type]

        if r.entity_type == "hypothesis":
            hyp = hyp_by_id.get(r.entity_id)
            if hyp is None:
                continue  # orphan(이미 search_similar_embeddings가 걸러야 정상이나 방어적 스킵).
            goal = hyp.statement
            # 미르코 FE 라우트 실측(2026-07-02): apps/web에 독립 hypothesis 상세 페이지 없음
            # (/epics/[id] 임베드뿐+epic_ids 다대다라 치환도 모호) — null(FE가 링크 생략 처리).
            href = None
            decision = None
            outcome = _build_outcome(hyp)
        elif r.entity_type == "loop":
            lp = loop_by_id.get(r.entity_id)
            if lp is None:
                continue
            goal = lp.title
            href = f"/loops/{r.entity_id}"
            decision = _build_decision(decision_artifacts_by_loop.get(lp.id, []))
            linked_hyp = hyp_by_id.get(lp.hypothesis_id) if lp.hypothesis_id else None
            outcome = _build_outcome(linked_hyp) if linked_hyp is not None else None
        else:  # loop_artifact → "decision"
            artifact = artifact_by_id.get(r.entity_id)
            if artifact is None:
                continue
            goal = artifact.variant_label
            href = f"/loops/{artifact.loop_id}"
            decision = None
            outcome = None

        items.append(ContextPackItem(
            entity_type=display_type, entity_id=r.entity_id, similarity=r.similarity,
            goal=goal, decision=decision, outcome=outcome, href=href,
        ))
    return items


def _build_decision(artifacts: list[LoopArtifact]) -> ContextPackDecision:
    chosen = next((a for a in artifacts if a.decision == "chosen"), None)
    rejected_candidates = sorted(
        (a for a in artifacts if a.decision == "rejected"),
        key=lambda a: a.created_at, reverse=True,
    )
    top_rejected = rejected_candidates[0] if rejected_candidates else None
    return ContextPackDecision(
        chosen=ContextPackDecisionSide(label=chosen.variant_label, reason=chosen.choose_reason) if chosen else None,
        rejected=[
            ContextPackDecisionSide(label=top_rejected.variant_label, reason=top_rejected.rejection_reason)
        ] if top_rejected else [],
    )


def _build_outcome(hyp: Hypothesis | None) -> ContextPackOutcome | None:
    if hyp is None or hyp.status not in _RESOLVED_HYPOTHESIS_STATUSES:
        return None
    result = hyp.outcome_result or {}
    return ContextPackOutcome(
        hypothesis_status=hyp.status,
        metric=result.get("metric"),
        actual=result.get("actual"),
        target=result.get("target"),
        direction=result.get("direction"),
    )
