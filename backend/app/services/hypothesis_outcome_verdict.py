"""HO-S2: hypothesis outcome → verdict 배선 (블루프린트 §2.2~§2.3·키스톤).

verified/falsified로 해소된 가설의 outcome을 linked story의 participation에 verdict로 기록해 H1↔E1
루프를 닫는다. trust를 "AC 통과"가 아니라 "가설 적중 이력(hypothesis_hit_rate)"으로 쌓는 핵심 배선.

credit 분리(implementer를 나쁜 bet으로 벌하지 않음):
  · **bet**(`hypothesis_outcome_bet`): 가설 책임자(owner 1차·confirmed_by 보조)에게. verified→pass·
    falsified→fail. role_key=`hypothesis_owner`(HO-S3가 seed; 미시드면 ensure가 None→skip).
  · **execution**(`hypothesis_outcome_execution`): linked story의 implementation participation에.
    verified→pass·**falsified→None(보류)** — MVP는 자동 attribution 안 하고 사람이 post-review로 확정.

신규 테이블 0(Cage verdict 재사용·record_verdict의 uq(participation,source) upsert 멱등).
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hypothesis import HypothesisStoryLink
from app.services.verdict_capture import ensure_review_participation, resolve_implementation_participation
from app.services.verdict_recorder import record_verdict

BET_SOURCE = "hypothesis_outcome_bet"
EXECUTION_SOURCE = "hypothesis_outcome_execution"
# bet 책임자 participation 역할 키. HO-S3가 ParticipationRole(key=이 값)을 seed한다(미시드면 bet skip).
BET_ROLE_KEY = "hypothesis_owner"

_RESOLVED = frozenset({"verified", "falsified"})


async def record_outcome_verdicts(session: AsyncSession, hypothesis) -> dict[str, Any]:
    """resolved 가설의 outcome을 linked story participation에 verdict로 기록.

    호출자(HO-S4 scorer)가 verified/falsified 전이 직후 호출. commit은 호출자 책임.
    measuring/active/manual-미해소 가설은 verdict 0(AC④). linked story 없으면 skip+summary(AC②).
    """
    if hypothesis.status not in _RESOLVED:
        return {"skipped_reason": "not_resolved", "bet": [], "execution": []}  # AC④

    bet_result = "pass" if hypothesis.status == "verified" else "fail"
    # 블루프린트 §2.3: falsified 시 execution은 자동 fail 귀속 금지 → None(보류·사람 attribution).
    execution_result = "pass" if hypothesis.status == "verified" else None

    org_id = hypothesis.org_id
    story_ids = list(
        (
            await session.execute(
                select(HypothesisStoryLink.story_id).where(
                    HypothesisStoryLink.hypothesis_id == hypothesis.id
                )
            )
        ).scalars().all()
    )
    if not story_ids:
        return {"skipped_reason": "no_linked_story", "bet": [], "execution": []}  # AC②

    # bet 책임자 — owner(1차) + confirmed_by(보조), 중복 제거.
    bet_members: list[uuid.UUID] = []
    for m in (hypothesis.owner_member_id, getattr(hypothesis, "confirmed_by_member_id", None)):
        if m is not None and m not in bet_members:
            bet_members.append(m)

    bet_recorded: list[str] = []
    execution_recorded: list[str] = []
    for story_id in story_ids:
        # execution verdict — implementation participation(AC③: 없으면 execution skip).
        impl = await resolve_implementation_participation(session, org_id, story_id)
        if impl is not None:
            await record_verdict(session, org_id, impl.id, EXECUTION_SOURCE, execution_result)
            execution_recorded.append(str(impl.id))
        # bet verdict — owner/confirmed_by의 bet 역할 participation(role 미시드면 ensure가 None→skip).
        for member_id in bet_members:
            part = await ensure_review_participation(session, org_id, story_id, member_id, BET_ROLE_KEY)
            if part is not None:
                await record_verdict(session, org_id, part.id, BET_SOURCE, bet_result)
                bet_recorded.append(str(part.id))

    return {
        "hypothesis_id": str(hypothesis.id),
        "status": hypothesis.status,
        "bet_result": bet_result,
        "execution_result": execution_result,
        "bet": bet_recorded,
        "execution": execution_recorded,
        "skipped_reason": None,
    }
