"""E-OUTCOME-LOOP S3: 스프린트 종료 채점 서비스 (MVP).

채점 대상: metric_definition 채워진 sprint.
소스별 처리:
  - source='internal_ops': velocity 기반 hit/miss 이진 채점.
  - 그 외: pending (외부 소스 MVP 범위 밖).
  - metric_definition 없음: n_a 유지 (의도 없음).

outcome_status 전이: n_a → pending → hit | miss
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def score_sprint_outcome(
    metric_definition: dict[str, Any] | None,
    velocity: int,
) -> dict[str, Any] | None:
    """sprint.metric_definition + velocity 기반 채점.

    Returns:
        None              → outcome_status 변경 없음 (n_a 유지)
        {'outcome_status': ..., 'outcome_result': ...} → update에 적용할 kwargs
    """
    if not metric_definition:
        return None  # 의도 없음 → n_a 유지

    source = metric_definition.get("source")
    metric = metric_definition.get("metric")
    target = metric_definition.get("target")
    direction = metric_definition.get("direction")

    if source != "internal_ops":
        # 외부 소스 — MVP 범위 밖, pending 대기
        return {"outcome_status": "pending", "outcome_result": None}

    # internal_ops: velocity를 actual로 사용 (done story points 합산)
    try:
        target_f = float(target)  # type: ignore[arg-type]
        actual_f = float(velocity)
    except (TypeError, ValueError):
        return {"outcome_status": "pending", "outcome_result": None}

    if direction == "up":
        hit = actual_f >= target_f
    elif direction == "down":
        hit = actual_f <= target_f
    else:
        return {"outcome_status": "pending", "outcome_result": None}

    return {
        "outcome_status": "hit" if hit else "miss",
        "outcome_result": {
            "metric": metric,
            "target": target_f,
            "actual": actual_f,
            "direction": direction,
            "scored_at": datetime.now(timezone.utc).isoformat(),
        },
    }
