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

⭐"학습된 선례"만 회수(PO 결, 2026-07-02, S13 QA에서 유나가 근본 설계로 승화): Context Pack의
목적은 과거에서 배우는 것 — 아직 결정/성과가 없는 in-flight 항목은 배울 신호가 0이라 노이즈다.
유사도 검색 결과에서 이 조건을 만족 못 하는 항목은 아예 드롭한다(단순 필드 null 처리가 아니라
항목 자체를 제외): hypothesis=verified/falsified만(미해소 제외)·loop=chosen artifact가 있는
것만(pre-decision/in-flight 제외 — 부수효과로 decision.chosen이 loop 항목에선 항상 non-null이
되어 S13의 nullable 처리 크래시도 근본 차단)·loop_artifact(decision)=decision!='pending'만.
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
    synthesis = _synthesize_learnings(items)
    recommendation = await _recommend_next_step(session, org_id, loop, synthesis, len(items))
    return ContextPackResponse(
        items=items, embed_available=True, synthesis=synthesis, recommendation=recommendation,
    )


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
            if hyp.status not in _RESOLVED_HYPOTHESIS_STATUSES:
                continue  # PO 결: "학습된 선례"만 회수 — 미해소(outcome 없음)는 배울 신호 0.
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
            loop_artifacts = decision_artifacts_by_loop.get(lp.id, [])
            if not any(a.decision == "chosen" for a in loop_artifacts):
                continue  # PO 결: pre-decision(in-flight) loop 제외 — 결정 없어 배울 신호 0(노이즈).
                # 동시에 chosen이 항상 존재를 보장해 FE decision.chosen이 실질 non-null(S13 크래시 근본 차단).
            goal = lp.title
            href = f"/loops/{r.entity_id}"
            decision = _build_decision(loop_artifacts)
            linked_hyp = hyp_by_id.get(lp.hypothesis_id) if lp.hypothesis_id else None
            outcome = _build_outcome(linked_hyp) if linked_hyp is not None else None
        else:  # loop_artifact → "decision"
            artifact = artifact_by_id.get(r.entity_id)
            if artifact is None:
                continue
            if artifact.decision == "pending":
                continue  # PO 결: 미결정 아티팩트도 배울 신호 없음(같은 원칙 일관 적용).
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


# ── S26: L2 학습 종합(회수 items→증류) ────────────────────────────────────────

_SYNTHESIS_INSTRUCTION = (
    "다음은 유사한 과거 실행(loop/가설)들의 실제 기록이다. 아래 데이터에 명시된 사실만 근거로 "
    "공통 패턴이나 성공/실패 요인을 한국어 2~3문장으로 요약하라. 데이터에 없는 내용은 절대 "
    "추정하거나 새로 만들어내지 마라 — 각 항목의 목표/채택·기각 이유/성과만 사용한다."
)


def _build_synthesis_prompt(items: list[ContextPackItem]) -> str:
    """⭐환각 방지(S26 AC②): 회수된 items 필드를 그대로 나열 — 프롬프트에 없는 사실은
    모델이 만들어낼 근거 자체가 없다(items 밖 지식 주입 0)."""
    lines = [_SYNTHESIS_INSTRUCTION, ""]
    for i, item in enumerate(items, start=1):
        lines.append(f"[{i}] 목표: {item.goal}")
        if item.decision is not None:
            if item.decision.chosen is not None:
                reason = item.decision.chosen.reason or "(이유 미기록)"
                lines.append(f"    채택: {item.decision.chosen.label} — 이유: {reason}")
            for rej in item.decision.rejected:
                reason = rej.reason or "(이유 미기록)"
                lines.append(f"    기각: {rej.label} — 이유: {reason}")
        if item.outcome is not None:
            lines.append(
                f"    성과: {item.outcome.hypothesis_status}"
                f"(metric={item.outcome.metric} target={item.outcome.target} "
                f"actual={item.outcome.actual} direction={item.outcome.direction})"
            )
        lines.append("")
    lines.append("요약(2~3문장, 위 데이터에 명시된 사실만 근거로):")
    return "\n".join(lines)


def _synthesize_learnings(items: list[ContextPackItem]) -> str | None:
    """S26 AC②③: items 0건이면 종합할 근거가 없으므로 즉시 None(LLM 호출 자체를 안 함).
    gen-LLM(S25) 미가용/실패 시에도 None — build_loop_context_pack이 이미 조립한 items(L1)는
    이 함수와 무관하게 그대로 반환되므로 패널은 퇴화 없이 raw 목록만 보여준다."""
    if not items:
        return None
    try:
        from app.services.llm_client import generate_text

        return generate_text(_build_synthesis_prompt(items))
    except Exception as exc:
        logger.warning("context-pack synthesis 실패(생략 처리): %s", exc)
        return None


# ── S27: L3 능동 추천(synthesis+새 loop goal/hypothesis→처방) ────────────────────

_RECOMMENDATION_INSTRUCTION = (
    "다음은 새로 시작하는 loop의 목표와, 과거 유사 실행들에서 이미 종합된 학습 요약이다. 이 "
    "학습 요약이 새 loop에 실질적으로 도움이 되는 구체적 제안을 한국어 1~2문장으로 하라. 요약 "
    "밖의 사실을 추정하거나 새로 만들어내지 마라. 근거(과거 사례 수)가 적거나 애매하면 "
    "단정적으로 처방하지 말고 '과거 N건 기준' 같은 정직한 hedge를 반드시 포함해 신중하게 "
    "제안하라."
)


def _build_recommendation_prompt(
    new_goal: str, new_hypothesis: str | None, synthesis: str, item_count: int,
) -> str:
    """⭐과신 방지(S27 AC②): 근거는 synthesis(이미 items 근거로만 만들어진 종합)뿐 — 새 loop의
    goal/hypothesis는 처방 "대상"을 명시할 뿐 학습 근거로 주입되지 않는다(items 밖 사실 0)."""
    lines = [_RECOMMENDATION_INSTRUCTION, "", f"[새 loop] 목표: {new_goal}"]
    if new_hypothesis:
        lines.append(f"           가설: {new_hypothesis}")
    lines.extend([
        "",
        f"[과거 학습 종합 — 근거 {item_count}건]",
        synthesis,
        "",
        "제안(1~2문장, hedge 포함):",
    ])
    return "\n".join(lines)


async def _recommend_next_step(
    session: AsyncSession, org_id: uuid.UUID, loop: LoopRun, synthesis: str | None, item_count: int,
) -> str | None:
    """S27 AC①③: synthesis가 없으면(L2 자체가 근거 부족으로 실패/생략) 추천을 아예 시도하지
    않는다 — 종합도 없이 처방하는 것은 과잉(과신) 처방이라 원천 차단."""
    if synthesis is None:
        return None
    hyp_statement: str | None = None
    if loop.hypothesis_id is not None:
        hyp_statement = (await session.execute(
            select(Hypothesis.statement).where(
                Hypothesis.id == loop.hypothesis_id, Hypothesis.org_id == org_id
            )
        )).scalar_one_or_none()
    try:
        from app.services.llm_client import generate_text

        prompt = _build_recommendation_prompt(loop.title, hyp_statement, synthesis, item_count)
        return generate_text(prompt)
    except Exception as exc:
        logger.warning("context-pack recommendation 실패(생략 처리): %s", exc)
        return None
