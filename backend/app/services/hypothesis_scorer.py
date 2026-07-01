"""E1-S4: Hypothesis scorer 최소형 (블루프린트 §8.3·§2.5).

measure_after가 도래한 가설을 채점한다. legacy outcome_scorer(sprint/story/epic)와
완전히 분리 — 본 서비스는 hypotheses 테이블만 건드린다.

상태 전이(§2.5):
    active → measuring   (measure_after <= now, 채점 대상 진입)
    measuring → verified (지표가 임계값 통과 = hit)
    measuring → falsified(통과 못 함 = miss)
    measuring 유지       (GA4 인증불가·데이터없음·회수실패·미지원 source = pending)

지표 채점은 legacy helper를 재사용한다(§8.3.2):
    source='ga4'          → score_ga4_outcome (GA4 Data API)
    source='internal_ops' (metric=completion_pct) → 링크된 스토리 완료율 → score_epic_outcome
    그 외(manual 등)       → 자동 채점 안 함(§10.4), measuring 유지.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hypothesis import Hypothesis, HypothesisStoryLink
from app.models.pm import Story
from app.services.outcome_scorer import score_epic_outcome, score_ga4_outcome

logger = logging.getLogger(__name__)

# outcome_scorer의 hit/miss → hypothesis lifecycle 상태.
_OUTCOME_TO_STATUS = {"hit": "verified", "miss": "falsified"}


async def _linked_story_completion_pct(session: AsyncSession, hypothesis_id) -> float:
    """internal_ops completion_pct — 가설에 링크된 스토리의 done 비율(%)."""
    rows = (await session.execute(
        select(Story.status)
        .join(HypothesisStoryLink, HypothesisStoryLink.story_id == Story.id)
        .where(
            HypothesisStoryLink.hypothesis_id == hypothesis_id,
            Story.deleted_at.is_(None),
        )
    )).scalars().all()
    total = len(rows)
    done = sum(1 for s in rows if s == "done")
    return round((done / total * 100) if total > 0 else 0.0, 2)


def _score_metric(scoring_source: str | None) -> bool:
    return scoring_source in ("ga4", "internal_ops")


async def score_hypotheses(session: AsyncSession) -> dict[str, Any]:
    """measure_after 도래 가설을 채점. 반환은 카운트/목록(관측 정직성).

    active는 먼저 measuring으로 전이한 뒤 같은 패스에서 채점한다(hit/miss면 verified/falsified,
    아니면 measuring 유지). 호출자(cron route)가 commit한다.
    """
    now = datetime.now(timezone.utc)
    to_measuring: list[str] = []
    verified: list[str] = []
    falsified: list[str] = []
    pending: list[str] = []
    failed: list[dict] = []
    # HO-S4: 해소(verified/falsified) 직후 outcome verdict 배선 결과(가설 적중 이력→trust).
    verdicts_recorded: list[dict] = []
    verdicts_skipped: list[dict] = []
    # E-LOOP-LEDGER S7: 해소 직후 loop outcome 귀속 배선 결과(복리 되먹임 고리).
    loops_attributed: list[dict] = []
    from app.services.hypothesis_outcome_verdict import record_outcome_verdicts
    from app.services.loop_outcome_attribution import attribute_loop_outcome

    hyps = (await session.execute(
        select(Hypothesis).where(
            Hypothesis.measure_after <= now,
            Hypothesis.status.in_(["active", "measuring"]),
        )
    )).scalars().all()

    for hyp in hyps:
        # active → measuring (measure_after 도래)
        if hyp.status == "active":
            hyp.status = "measuring"
            to_measuring.append(str(hyp.id))

        md = hyp.metric_definition or {}
        source = md.get("source")
        try:
            if source == "ga4":
                scoring = score_ga4_outcome(md)
            elif source == "internal_ops":
                pct = await _linked_story_completion_pct(session, hyp.id)
                result = score_epic_outcome(md, pct)
                scoring = result if result is not None else {"outcome_status": "pending", "outcome_result": None}
            else:
                # manual·미지원 source → 자동 채점 금지(거짓 신호 차단). measuring 유지.
                scoring = {"outcome_status": "pending", "outcome_result": None}
        except Exception as exc:  # GA4 회수 등 실패 → measuring 유지(위장 금지)
            logger.warning("hypothesis scoring failed id=%s: %s", hyp.id, exc)
            failed.append({"id": str(hyp.id), "error": str(exc)})
            continue

        new_status = _OUTCOME_TO_STATUS.get(scoring["outcome_status"])
        if new_status is not None:
            hyp.status = new_status
            hyp.outcome_result = scoring["outcome_result"]
            (verified if new_status == "verified" else falsified).append(str(hyp.id))
            # HO-S4(AC①): 해소 직후 outcome→verdict 배선(체인: scorer→verdict→trust 닫힘).
            # manual/pending은 여기 도달 안 함(new_status None)이라 verdict 0(AC④).
            vres = await record_outcome_verdicts(session, hyp)
            if vres.get("skipped_reason"):
                verdicts_skipped.append({"hypothesis_id": str(hyp.id), "reason": vres["skipped_reason"]})
            else:
                verdicts_recorded.append({
                    "hypothesis_id": str(hyp.id),
                    "bet": vres.get("bet", []),
                    "execution": vres.get("execution", []),
                })
            # E-LOOP-LEDGER S7: 이 가설에 연결된 measuring 상태 loop 귀속(있으면). loop이 아직
            # measuring에 도달하지 못했으면(전이 배선 갭·별도 스토리) no_measuring_loop로 skip.
            lres = await attribute_loop_outcome(session, hyp)
            if lres.get("attributed"):
                loops_attributed.append({"hypothesis_id": str(hyp.id), "loop_ids": lres["attributed"]})
        else:
            pending.append(str(hyp.id))  # measuring 유지

    return {
        "to_measuring": to_measuring,
        "verified": verified,
        "falsified": falsified,
        "pending": pending,
        "failed": failed,
        "total": len(hyps),
        # HO-S4(AC②): outcome verdict 배선 결과를 cron response에 노출.
        "verdicts_recorded": verdicts_recorded,
        # S7: loop outcome 귀속 결과를 cron response에 노출(관측 정직성).
        "loops_attributed": loops_attributed,
        "verdicts_skipped": verdicts_skipped,
    }
