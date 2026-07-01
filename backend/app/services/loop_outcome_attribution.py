"""E-LOOP-LEDGER S7: hypothesis 해소 → loop outcome 귀속 배선(블루프린트 §7).

hypothesis_outcome_verdict.record_outcome_verdicts(HO-S4)와 완전히 동형 — 호출자
(hypothesis_scorer.score_hypotheses)가 verified/falsified 전이 직후 호출하고 commit은
호출자 책임. 신규 cron/엔드포인트 0(기존 outcome-loop 배선 재사용).

⚠️scope: 이 배선은 loop.status=='measuring'인 loop만 대상 — draft→...→deciding·
executing→measuring 같은 loop 자체의 상태전이 트리거는 별도 스토리(전이 배선 갭, 오르테가
PO가 보완 스토리로 회수) 스코프다. 여기서는 "이미 measuring인 loop"을 전제로만 동작한다.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.loop import LoopRun, is_valid_transition

_RESOLVED = frozenset({"verified", "falsified"})


async def attribute_loop_outcome(session: AsyncSession, hypothesis) -> dict[str, Any]:
    """resolved(verified/falsified) 가설에 연결된 measuring 상태 loop에 outcome을 귀속.

    hypothesis.status not in (verified,falsified) → skip(not_resolved, HO-S4와 동일 게이팅).
    loop.hypothesis_id로 연결된 loop 중 status=='measuring'인 것만 대상(measuring→closed만
    합법 전이라 자연 필터) — 없으면 skip(no_measuring_loop). outcome_attributed_at이 이미
    있으면 그 loop은 건너뛴다(불변 — 한번 스탬프된 snapshot은 재변경하지 않음).
    """
    if hypothesis.status not in _RESOLVED:
        return {"skipped_reason": "not_resolved", "attributed": []}

    # 까심 QA CRITICAL(#1818 S7 QA) — org_id 스코프 없으면 cross-org 데이터 유출: 근본 fix는
    # create_loop(app/services/loop.py)가 이제 hypothesis_id의 org/project 소속을 생성 시점에
    # 검증하지만, 여기도 defense-in-depth로 org_id를 명시 필터한다(다른 loop 쿼리들과 일관 —
    # 미래에 create_loop 가드가 우회/누락되는 경로가 생겨도 이 쿼리 자체가 타org 유출을 차단).
    loops = (await session.execute(
        select(LoopRun).where(
            LoopRun.hypothesis_id == hypothesis.id,
            LoopRun.org_id == hypothesis.org_id,
            LoopRun.status == "measuring",
        )
    )).scalars().all()
    if not loops:
        return {"skipped_reason": "no_measuring_loop", "attributed": []}

    now = datetime.now(timezone.utc)
    attributed: list[str] = []
    already_attributed: list[str] = []
    for loop in loops:
        if loop.outcome_attributed_at is not None:
            already_attributed.append(str(loop.id))
            continue
        if not is_valid_transition(loop.status, "closed"):
            continue  # 방어: measuring 필터로 이미 보장되지만 FSM SSOT 재확인.
        loop.outcome_snapshot = {
            "hypothesis_id": str(hypothesis.id),
            "hypothesis_status": hypothesis.status,
            "outcome_result": hypothesis.outcome_result,
            "attributed_at": now.isoformat(),
        }
        loop.outcome_attributed_at = now
        loop.status = "closed"
        attributed.append(str(loop.id))

    result: dict[str, Any] = {"attributed": attributed}
    if already_attributed:
        result["already_attributed"] = already_attributed
    return result
