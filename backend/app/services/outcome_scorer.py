"""E-OUTCOME-LOOP S3: 스프린트 종료 채점 서비스 (MVP).

채점 대상: metric_definition 채워진 sprint.
소스별 처리:
  - source='internal_ops': metric 이름으로 actual 분기.
      velocity          → done story points 합산
      backlog_remaining → 미완료(done 아닌) 스토리 수
      progress          → 완료율 (done_points / total_points * 100)
      그 외             → pending (오채점 차단)
  - 그 외: pending (외부 소스 MVP 범위 밖).
  - metric_definition 없음: n_a 유지 (의도 없음).

outcome_status 전이: n_a → pending → hit | miss
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

# internal_ops에서 지원하는 metric 이름 → 회수 키 매핑
_INTERNAL_OPS_METRICS = frozenset({"velocity", "backlog_remaining", "progress"})


def score_sprint_outcome(
    metric_definition: dict[str, Any] | None,
    velocity: int,
    backlog_remaining: int,
    total_points: int,
) -> dict[str, Any] | None:
    """sprint.metric_definition 기반 채점.

    Args:
        metric_definition: sprint.metric_definition JSONB
        velocity:          done story points 합산
        backlog_remaining: done 아닌 스토리 수 (close 시점)
        total_points:      sprint 전체 story_points 합산 (진행률 분모)

    Returns:
        None                                  → outcome_status 변경 없음 (n_a 유지)
        {'outcome_status': ..., 'outcome_result': ...} → update에 적용할 kwargs
    """
    if not metric_definition:
        return None  # 의도 없음 → n_a 유지

    source = metric_definition.get("source")
    metric = metric_definition.get("metric")
    target = metric_definition.get("target")
    direction = metric_definition.get("direction")

    if source != "internal_ops":
        return {"outcome_status": "pending", "outcome_result": None}

    # metric 이름으로 actual 분기 — 모르는 metric은 오채점 차단
    if metric == "velocity":
        actual_raw: float = float(velocity)
    elif metric == "backlog_remaining":
        actual_raw = float(backlog_remaining)
    elif metric == "progress":
        actual_raw = round((velocity / total_points * 100) if total_points > 0 else 0.0, 2)
    else:
        # 지원하지 않는 metric → 오채점 방지 pending
        return {"outcome_status": "pending", "outcome_result": None}

    try:
        target_f = float(target)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return {"outcome_status": "pending", "outcome_result": None}

    if direction == "up":
        hit = actual_raw >= target_f
    elif direction == "down":
        hit = actual_raw <= target_f
    else:
        return {"outcome_status": "pending", "outcome_result": None}

    return {
        "outcome_status": "hit" if hit else "miss",
        "outcome_result": {
            "metric": metric,
            "target": target_f,
            "actual": actual_raw,
            "direction": direction,
            "scored_at": datetime.now(timezone.utc).isoformat(),
        },
    }
