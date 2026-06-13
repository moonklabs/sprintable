"""HO-S7: cold-start human seed 기록 + calibration (블루프린트 E-HO-TRUST §3.5/Story7).

outcome trust 표본이 부족한 cold-start에서 머지 게이트는 ask_human이 된다([[merge_verdict_gate]]
AC④). 이때 사람이 내리는 keep(approve)/kill(reject) 결정을 **seed**로 기록한다 — 가설 적중 이력이
없는 동안의 임시 예측. seed는:

- **verdict source 재사용**(source="human_seed") — 신규 테이블/마이그 0(AC⑤). Verdict.source는
  free-form String(50)이라 enum 변경도 없다.
- **outcome trust 본점수 미포함**(AC②): trust_score.OUTCOME_SOURCES={bet,execution}만 집계하므로
  human_seed는 자동 제외된다(코드 변경 0). seed는 신뢰 환산이 아니라 calibration 관측용.
- outcome 해소 후 **seed_calibration**(AC③): 사람의 keep/kill 예측이 실제 verified/falsified와
  맞았는지 대조. cold-start 판단 품질을 사후 계측.

FE는 cold-start seed로 머지된 건을 "임시 예측"으로 표시한다(AC④) — gate.neutral_facts의
cold_start_seed/seed_prediction 플래그를 데이터 계약으로 제공한다.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.gate import Gate

# human keep/kill 예측 seed의 verdict source. OUTCOME_SOURCES에 없으므로 trust 본점수에서 제외된다.
SEED_SOURCE = "human_seed"


def _is_cold_start(gate: Gate) -> bool:
    """게이트가 cold-start(outcome 표본 부족으로 ask_human이 된 상태)였는지.

    evaluate_merge_gate(HO-S6)가 neutral_facts에 남긴 outcome_resolved/min_outcome_sample로 판단.
    표본이 충분했다면(>=min) 사람 결정은 seed가 아니라 일반 review verdict로만 남는다.
    """
    facts = gate.neutral_facts or {}
    resolved = facts.get("outcome_resolved")
    min_sample = facts.get("min_outcome_sample")
    if resolved is None or min_sample is None:
        return False
    try:
        return int(resolved) < int(min_sample)
    except (TypeError, ValueError):
        return False


async def record_cold_start_seed(
    session: AsyncSession,
    org_id: uuid.UUID,
    gate: Gate,
    new_status: str,
    resolver_id: uuid.UUID | None,
) -> bool:
    """merge 게이트가 cold-start에서 사람에 의해 해소되면 keep/kill 예측을 seed로 기록.

    approve→keep(result=pass) / reject→kill(result=fail). source=human_seed라 trust 본점수
    미포함(AC②). uq(participation, source)로 멱등. FE 표시용 플래그를 neutral_facts에 남긴다(AC④).
    기록했으면 True.
    """
    if gate.gate_type != "merge" or gate.work_item_type != "story":
        return False
    if new_status not in ("approved", "rejected") or resolver_id is None:
        return False
    if not _is_cold_start(gate):
        return False

    # lazy import — verdict_capture/recorder가 gate_service를 import하므로 순환 회피(gate_service 경유).
    from app.services.verdict_capture import resolve_implementation_participation
    from app.services.verdict_recorder import record_verdict

    participation = await resolve_implementation_participation(session, org_id, gate.work_item_id)
    if participation is None:
        return False  # participation 없으면 거짓기록 금지.

    result = "pass" if new_status == "approved" else "fail"  # keep / kill
    await record_verdict(session, org_id, participation.id, SEED_SOURCE, result)

    # AC④: FE "임시 예측" 표시용 데이터 계약. neutral_facts에 플래그(판정 아님·관측).
    facts = dict(gate.neutral_facts or {})
    facts["cold_start_seed"] = True
    facts["seed_prediction"] = "keep" if new_status == "approved" else "kill"
    gate.neutral_facts = facts
    return True


async def compute_seed_calibration(
    session: AsyncSession,
    org_id: uuid.UUID,
    member_id: uuid.UUID | None = None,
) -> dict[str, Any]:
    """outcome 해소 후 seed 예측의 정확도(seed_calibration)를 계산(AC③).

    seed(human_seed verdict) → participation → story → 가설을 거쳐, keep/kill 예측이 실제
    verified/falsified와 일치했는지 대조한다. 가설이 아직 미해소면 calibration 보류(resolved 제외).

    keep(result=pass) 예측 ↔ verified 일치 / kill(result=fail) 예측 ↔ falsified 일치.
    반환: {total_seeds, resolved, calibrated, calibration_rate}.
    """
    from app.models.hypothesis import Hypothesis, HypothesisStoryLink
    from app.models.participation import Participation
    from app.models.verdict import Verdict

    # member 범위의 seed verdict + 그 participation의 story + story가 연결된 가설 status.
    q = (
        select(Verdict.result, Hypothesis.status)
        .join(Participation, Participation.id == Verdict.participation_id)
        .join(HypothesisStoryLink, HypothesisStoryLink.story_id == Participation.story_id)
        .join(Hypothesis, Hypothesis.id == HypothesisStoryLink.hypothesis_id)
        .where(Verdict.org_id == org_id, Verdict.source == SEED_SOURCE)
    )
    if member_id is not None:
        q = q.where(Participation.member_id == member_id)

    rows = (await session.execute(q)).all()
    total_seeds = len(rows)
    resolved = 0
    calibrated = 0
    for seed_result, hyp_status in rows:
        if hyp_status not in ("verified", "falsified"):
            continue  # 미해소 → calibration 보류.
        resolved += 1
        predicted_verified = seed_result == "pass"  # keep
        actual_verified = hyp_status == "verified"
        if predicted_verified == actual_verified:
            calibrated += 1

    return {
        "total_seeds": total_seeds,
        "resolved": resolved,
        "calibrated": calibrated,
        "calibration_rate": round(calibrated / resolved, 4) if resolved > 0 else None,
    }
