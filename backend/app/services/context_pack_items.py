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

import hashlib
import json
import logging
import re
import uuid
from datetime import datetime, timezone

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
    if not items:
        # 학습 근거 0건 — 종합/추천 시도 자체가 무의미(과잉 처방 방지, S26/S27 원칙). 캐시도 무관.
        return ContextPackResponse(items=items, embed_available=True, evidence_count=0)

    # evidence_count(유나 계약, 2026-07-02): items 수로 결정론적 산출 — LLM 산출물 아님.
    evidence_count = len(items)
    hyp_statement = await _load_loop_hypothesis_statement(session, org_id, loop)
    cache_key = _compute_cache_key(items, loop, hyp_statement)

    if loop.context_pack_cache_key == cache_key:
        # S28 AC④ — 회수 items+새 loop 맥락+모델/프롬프트 버전이 전부 이전과 동일 → gen-LLM
        # (Claude, 비용 높음) 재호출 없이 캐시 재사용("같은 입력=1회만 호출").
        synthesis = loop.context_pack_synthesis
        synthesis_confidence = loop.context_pack_synthesis_confidence
        recommendation = loop.context_pack_recommendation
        recommendation_confidence = loop.context_pack_recommendation_confidence
    else:
        synthesis, synthesis_confidence = _synthesize_learnings(items)
        recommendation, recommendation_confidence = _recommend_next_step(
            loop.title, hyp_statement, synthesis, evidence_count,
        )
        if synthesis is not None:
            # gen-LLM 미가용/실패(synthesis=None)면 캐시에 기록하지 않는다 — 일시적 장애를
            # 영구 캐시된 "결과 없음"으로 굳히면 안 됨(다음 요청이 다시 시도하게 둔다).
            from app.repositories.loop import LoopRunRepository

            await LoopRunRepository(session, org_id).update(
                loop.id,
                context_pack_cache_key=cache_key,
                context_pack_synthesis=synthesis,
                context_pack_synthesis_confidence=synthesis_confidence,
                context_pack_recommendation=recommendation,
                context_pack_recommendation_confidence=recommendation_confidence,
                context_pack_cached_at=datetime.now(timezone.utc),
            )

    return ContextPackResponse(
        items=items, embed_available=True,
        synthesis=synthesis, synthesis_confidence=synthesis_confidence,
        recommendation=recommendation, recommendation_confidence=recommendation_confidence,
        evidence_count=evidence_count,
    )


async def _load_loop_hypothesis_statement(
    session: AsyncSession, org_id: uuid.UUID, loop: LoopRun,
) -> str | None:
    if loop.hypothesis_id is None:
        return None
    return (await session.execute(
        select(Hypothesis.statement).where(
            Hypothesis.id == loop.hypothesis_id, Hypothesis.org_id == org_id
        )
    )).scalar_one_or_none()


def _compute_cache_key(items: list[ContextPackItem], loop: LoopRun, hyp_statement: str | None) -> str:
    """S28 AC④ — 회수 items(결정/성과)+새 loop 맥락+모델/프롬프트 버전이 전부 같을 때만 캐시
    hit. 선례 결정/성과가 바뀌거나(예: pending→chosen, 새 outcome 확정) 모델/프롬프트를
    바꾸면 입력 해시가 달라져 자동 무효화된다(별도 invalidation 로직 불요)."""
    from app.services.llm_client import CLAUDE_MODEL_VERSION

    payload = {
        "items": [
            {
                "entity_type": it.entity_type, "entity_id": str(it.entity_id), "goal": it.goal,
                "decision": it.decision.model_dump() if it.decision else None,
                "outcome": it.outcome.model_dump() if it.outcome else None,
            }
            for it in items
        ],
        "loop_title": loop.title,
        "hypothesis_statement": hyp_statement,
        "model": CLAUDE_MODEL_VERSION,
        "synthesis_prompt_version": _SYNTHESIS_PROMPT_VERSION,
        "recommendation_prompt_version": _RECOMMENDATION_PROMPT_VERSION,
    }
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


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


# ── S28: confidence 마커 파싱(유나 BE↔FE 계약, 2026-07-02) ─────────────────────

_CONFIDENCE_LEVELS = frozenset({"high", "medium", "low"})
# 대소문자 무관·줄 앞뒤 공백 허용·행 전체가 이 마커여야(본문 문장 중간의 우연한 일치 방지).
_CONFIDENCE_LINE_RE = re.compile(r"(?im)^\s*confidence:\s*(high|medium|low)\s*$")


def _extract_confidence(text: str) -> tuple[str, str | None]:
    """마지막 줄의 'confidence: high|medium|low' 마커를 본문에서 떼어내 구조화 필드로 뽑는다
    (텍스트 hedge "패턴 불명확 N건 부족"과 별개로 FE가 배지 렌더용 구조화 신호를 갖게 함).
    마커가 없거나 형식이 어긋나면 (원문 그대로, None) — 파싱 실패가 synthesis 자체를
    깨면 안 된다(non-fatal, 텍스트 표시는 항상 보장)."""
    match = _CONFIDENCE_LINE_RE.search(text)
    if match is None:
        return text.strip(), None
    confidence = match.group(1).lower()
    cleaned = _CONFIDENCE_LINE_RE.sub("", text, count=1).strip()
    return cleaned, confidence


# ── S26/S28: L2 학습 종합(회수 items→증류) ─────────────────────────────────────

# S28: 프롬프트 텍스트를 바꿀 때마다 버전을 올린다 — 캐시 키에 들어가 구 버전 캐시를
# 자동 무효화한다(_compute_cache_key).
_SYNTHESIS_PROMPT_VERSION = "v2"

# S28(선생님 dogfood 지적+PO crux): v1은 "요약해라"만 요구해 결정 재진술("C 채택, B 기각")에
# 그쳐 순환적·비-actionable이었다(까심/유나가 실 라이브 출력으로 확인). v2 근본 재설계:
# ①재진술 명시 금지 ②outcome(성과 FACT)을 결정-이유(주관적 서술)보다 우선 근거로 삼도록 강제
# — 이게 순환성의 진짜 해독제(PO crux 핵심: outcome은 재진술이 아니라 사실) ③구조 강제(패턴·
# 다음행동·회피·리스크)로 최소한 "무엇을 해야 하는지"까지 나오게 ④정직한 hedge("패턴
# 불명확") 유지 ⑤환각 방지(items 밖 사실 금지)는 v1 그대로 유지.
_SYNTHESIS_INSTRUCTION = (
    "다음은 유사한 과거 실행(loop/가설)들의 실제 기록이다. 이 데이터를 분석해 다음 실행에 "
    "실질적으로 도움이 되는 통찰을 한국어로 작성하라.\n\n"
    "금지: \"X가 채택되고 Y가 기각됐다\" 같은 단순 재진술은 절대 하지 마라 — 이미 알고 있는 "
    "사실이다. 왜 그런 선택이 반복됐는지 한 단계 더 깊이 파고들어라.\n\n"
    "성과(outcome) 우선 원칙: 성과 데이터(hit/miss·수치)가 있으면 그것을 최우선 근거로 삼아라 "
    "— 무엇이 실제로 효과가 있었는지가 가장 강한 신호다. 성과가 없으면 결정 이유만으로 신중히 "
    "판단하고 그 불확실성을 명시하라.\n\n"
    "다음 구조로 답하라(각 항목 1문장, 데이터에 명시된 사실만 근거로):\n"
    "- 패턴: 표면적 선택이 아니라 그 이면의 원리(비-obvious). 근거 부족하면 \"패턴 불명확(N건 "
    "부족)\"이라고 정직하게 표시.\n"
    "- 다음 행동: 다음 실행에서 시도해볼 만한 것 1가지(제안형으로 — 단정적 지시 아님).\n"
    "- 회피: 반복하지 않는 게 좋아 보이는 것 1가지.\n"
    "- 리스크: 이 결론의 불확실성/예외 가능성 1가지.\n\n"
    "데이터에 없는 사실을 추정하거나 새로 만들어내지 마라.\n\n"
    "마지막 줄에 정확히 다음 형식으로 확신도를 표시하라(그 외 텍스트 없이 이 형식 그대로):\n"
    "confidence: high|medium|low\n"
    "(성과 데이터가 있고 패턴이 명확하면 high, 결정 이유만 있고 사례가 적으면 low, 그 사이면 "
    "medium — 데이터 근거 강도에 정직하게 맞춰라.)"
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


def _synthesize_learnings(items: list[ContextPackItem]) -> tuple[str | None, str | None]:
    """S26 AC②③: items 0건이면 종합할 근거가 없으므로 즉시 (None, None)(LLM 호출 자체를 안
    함). gen-LLM 미가용/실패 시에도 (None, None) — build_loop_context_pack이 이미 조립한
    items(L1)는 이 함수와 무관하게 그대로 반환되므로 패널은 퇴화 없이 raw 목록만 보여준다.

    S28: Gemini(generate_text)→Claude(generate_text_claude, reasoning="disabled")로 전환.
    실측(2026-07-02): 이 프롬프트 규모(item 수 적음)엔 disabled와 low(adaptive) 레이턴시/
    thinking_tokens 차이가 사실상 0이라 비용 낮은 disabled 채택(선생님 결).

    반환 = (synthesis 본문, confidence). confidence 마커 파싱 실패해도 본문은 항상 보존."""
    if not items:
        return None, None
    try:
        from app.services.llm_client import generate_text_claude

        raw = generate_text_claude(_build_synthesis_prompt(items), reasoning="disabled")
        if raw is None:
            return None, None
        return _extract_confidence(raw)
    except Exception as exc:
        logger.warning("context-pack synthesis 실패(생략 처리): %s", exc)
        return None, None


# ── S27/S28: L3 능동 추천(synthesis+새 loop goal/hypothesis→처방) ─────────────────

_RECOMMENDATION_PROMPT_VERSION = "v2"

# S28(PO crux): v1은 순환성이 덜했지만(이미 "제안" 형태) outcome 우선 원칙+제안형 톤(유나
# voice 계약 LOCK — "돕되 대체 안 함")을 명시로 강화. synthesis가 이미 v2 구조(패턴/다음행동/
# 회피/리스크)라 이 프롬프트는 그걸 새 loop에 적용하는 역할.
_RECOMMENDATION_INSTRUCTION = (
    "다음은 새로 시작하는 loop의 목표와, 과거 유사 실행들에서 이미 종합된 학습(패턴·다음행동·"
    "회피·리스크)이다. 이 학습을 이 새 loop에 구체적으로 적용할 제안을 한국어 1~2문장으로 "
    "작성하라.\n\n"
    "성과(outcome) 우선: 학습 요약에 성과 데이터가 반영돼 있으면 그것을 최우선 근거로 삼아라 "
    "— 결과가 확인된 것이 가장 강한 신호다.\n\n"
    "톤: 단정적 지시가 아니라 제안형으로(\"~해보는 게 좋아 보입니다\", \"~을 고려해볼 만합니다\" "
    "등) — 최종 판단은 사람의 몫이다.\n\n"
    "요약 밖의 사실을 추정하거나 새로 만들어내지 마라. 근거(과거 사례 수)가 적거나 애매하면 "
    "단정적으로 처방하지 말고 '과거 N건 기준' 같은 정직한 hedge를 반드시 포함해 신중하게 "
    "제안하라.\n\n"
    "마지막 줄에 정확히 다음 형식으로 확신도를 표시하라(그 외 텍스트 없이 이 형식 그대로):\n"
    "confidence: high|medium|low\n"
    "(성과 기반 근거가 있고 사례가 여럿이면 high, 결정 이유만 있고 사례가 적으면 low, 그 "
    "사이면 medium — 데이터 근거 강도에 정직하게 맞춰라.)"
)


def _build_recommendation_prompt(
    new_goal: str, new_hypothesis: str | None, synthesis: str | None, item_count: int,
) -> str:
    """⭐과신 방지(S27 AC②): 근거는 synthesis(이미 items 근거로만 만들어진 종합)뿐 — 새 loop의
    goal/hypothesis는 처방 "대상"을 명시할 뿐 학습 근거로 주입되지 않는다(items 밖 사실 0).

    까심 RC: synthesis=None을 None-safe로 처리(TypeError로 크래시하지 않음) — 이래야
    _recommend_next_step의 `if synthesis is None: return None` 가드가 "유일한" 과잉처방
    방지 게이트가 된다(가드 없이 이 함수만으로는 크래시가 우연히 generate_text 미호출을
    만드는 masking을 방지 — 실제 프롬프트 조립이 어떤 입력에도 안전해야 가드의 존재 여부가
    테스트에서 정직하게 드러난다)."""
    lines = [_RECOMMENDATION_INSTRUCTION, "", f"[새 loop] 목표: {new_goal}"]
    if new_hypothesis:
        lines.append(f"           가설: {new_hypothesis}")
    lines.extend([
        "",
        f"[과거 학습 종합 — 근거 {item_count}건]",
        synthesis if synthesis else "(종합 없음)",
        "",
        "제안(1~2문장, hedge 포함):",
    ])
    return "\n".join(lines)


def _recommend_next_step(
    new_goal: str, new_hypothesis: str | None, synthesis: str | None, item_count: int,
) -> tuple[str | None, str | None]:
    """S27 AC①③: synthesis가 없으면(L2 자체가 근거 부족으로 실패/생략) 추천을 아예 시도하지
    않는다 — 종합도 없이 처방하는 것은 과잉(과신) 처방이라 원천 차단.

    S28: hyp_statement를 build_loop_context_pack이 미리 로드해 넘겨주므로 session/org_id/
    loop 의존 없는 순수 함수로 단순화(중복 조회 제거) + Claude(disabled) 전환 + confidence
    파싱. 반환 = (recommendation 본문, confidence)."""
    if synthesis is None:
        return None, None
    try:
        from app.services.llm_client import generate_text_claude

        prompt = _build_recommendation_prompt(new_goal, new_hypothesis, synthesis, item_count)
        raw = generate_text_claude(prompt, reasoning="disabled")
        if raw is None:
            return None, None
        return _extract_confidence(raw)
    except Exception as exc:
        logger.warning("context-pack recommendation 실패(생략 처리): %s", exc)
        return None, None
