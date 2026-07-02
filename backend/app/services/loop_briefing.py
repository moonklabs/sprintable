"""E-LOOP-LEDGER P1-S7: Context Pack 조립 — loop이 'briefing'으로 전이할 때 S6 유사도 검색을
내부 호출해 의미 유사한 과거 loop/결정(choose/reject 이유)/성과를 Doc으로 조립·brief_doc_id에
stamp한다(블루프린트 "복리 조직기억"의 실제 소비 지점, PO crux GO 2026-07-02).

⭐핵심 불변식(crux 합의): Context Pack 조립 실패가 loop 상태전이 자체를 절대 막지 않는다
(score_hypotheses/GA4의 "additive non-fatal" 계승 — 전이가 진짜 목적, Context Pack은 부가가치).
이 모듈의 assemble_context_pack_briefing은 embed/검색 단계에서 발생하는 모든 예외를 내부에서
흡수해 Doc 콘텐츠의 3갈래 중 하나로 반영한다(N건 매칭/0건 매칭/embed 자체 불가) — 항상 Doc을
만들고 결과 id를 반환한다(브리핑 전이마다 brief_doc_id가 결정론적으로 채워짐). Doc 생성 자체가
실패하는 진짜 이상 상황만 예외로 전파해 호출자(transition_loop)의 최종 try/except가 방어한다.

쿼리 벡터는 loop 자신의 title+goal_tags를 embed_client로 동기 임베드(S6와 동형 — briefing 전이는
infrequent해 latency/비용 허용). 결과에서 자기 자신(entity_type='loop'·entity_id=이 loop)은
제외(자기유사 100% 노이즈). embedding_text는 title+goal_tags(loop)/statement(hypothesis)만
담아 "성과"가 빠지므로, hypothesis/loop는 outcome_result/outcome_snapshot을 배치 재로드해
보강한다 — loop_artifact는 choose/rejection_reason이 이미 embedding_text에 있어 재로드 불요.
"""
from __future__ import annotations

import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hypothesis import Hypothesis
from app.models.loop import LoopRun

logger = logging.getLogger(__name__)

_SEARCH_LIMIT = 5


async def assemble_context_pack_briefing(
    session: AsyncSession, org_id: uuid.UUID, loop: LoopRun,
) -> uuid.UUID:
    results = []
    embed_unavailable = False
    try:
        from app.services.embedding_client import embed_text
        from app.services.embedding_enqueue import build_loop_embedding_text

        query_text = build_loop_embedding_text(loop.title, loop.goal_tags)
        vector = embed_text(query_text)
        if vector is None:
            embed_unavailable = True
        else:
            from app.services.context_pack_search import search_similar_embeddings

            raw = await search_similar_embeddings(session, org_id, loop.project_id, vector, limit=_SEARCH_LIMIT)
            results = [r for r in raw if not (r.entity_type == "loop" and r.entity_id == loop.id)]
    except Exception as exc:  # embed/검색 실패는 Doc 콘텐츠로 흡수(전이 차단 절대 금지).
        logger.warning("context-pack 조립: embed/검색 실패(생략 처리): %s", exc)
        embed_unavailable = True
        results = []

    content = await _render_briefing_content(session, results, embed_unavailable)

    from app.repositories.doc import DocRepository
    from app.services.doc_slug import resolve_unique_slug, slugify

    base_slug = slugify(f"context-pack-{loop.title}") or f"context-pack-{loop.id.hex[:10]}"
    slug = await resolve_unique_slug(session, org_id, loop.project_id, base_slug)

    repo = DocRepository(session, org_id)
    doc = await repo.create(
        project_id=loop.project_id,
        title=f"Context Pack: {loop.title}",
        slug=slug,
        content=content,
        doc_type="page",
        created_by=loop.created_by_member_id,
    )
    return doc.id


async def _render_briefing_content(session: AsyncSession, results: list, embed_unavailable: bool) -> str:
    if embed_unavailable:
        return "## Context Pack\n\n임베딩 서비스 일시 불가로 관련 이력 조회를 생략했습니다."
    if not results:
        return "## Context Pack\n\n관련된 과거 loop/결정/성과를 찾지 못했습니다."

    hyp_ids = {r.entity_id for r in results if r.entity_type == "hypothesis"}
    loop_ids = {r.entity_id for r in results if r.entity_type == "loop"}

    hyp_by_id: dict[uuid.UUID, Hypothesis] = {}
    if hyp_ids:
        rows = (await session.execute(select(Hypothesis).where(Hypothesis.id.in_(hyp_ids)))).scalars().all()
        hyp_by_id = {h.id: h for h in rows}

    loop_by_id: dict[uuid.UUID, LoopRun] = {}
    if loop_ids:
        rows = (await session.execute(select(LoopRun).where(LoopRun.id.in_(loop_ids)))).scalars().all()
        loop_by_id = {lp.id: lp for lp in rows}

    lines = [f"## Context Pack\n", f"과거 유사 항목 {len(results)}건 발견.\n"]
    for i, r in enumerate(results, start=1):
        lines.append(f"### {i}. [{r.entity_type}] {r.embedding_text} (유사도: {r.similarity:.2f})")
        if r.entity_type == "hypothesis" and r.entity_id in hyp_by_id:
            h = hyp_by_id[r.entity_id]
            lines.append(f"성과: {h.status}" + (f" — {h.outcome_result}" if h.outcome_result else ""))
        elif r.entity_type == "loop" and r.entity_id in loop_by_id:
            lp = loop_by_id[r.entity_id]
            lines.append(f"성과: {lp.status}" + (f" — {lp.outcome_snapshot}" if lp.outcome_snapshot else ""))
        lines.append("")
    return "\n".join(lines)
