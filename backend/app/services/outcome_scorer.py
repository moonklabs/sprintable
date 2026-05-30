"""E-OUTCOME-LOOP S3/S5: 스프린트·스토리 종료 채점 서비스.

채점 대상: metric_definition 채워진 sprint/story.
소스별 처리:
  - source='internal_ops': metric 이름으로 actual 분기.
      velocity          → done story points 합산
      backlog_remaining → 미완료(done 아닌) 스토리 수
      progress          → 완료율 (done_points / total_points * 100)
      그 외             → pending (오채점 차단)
  - source='ga4': GA4 Data API runReport로 실제값 회수 (S5).
      property_id + ga4_metric + date_range_days 필수.
      인증 불가·데이터 없음·회수 실패 → pending.
  - 그 외: pending (외부 소스 범위 밖).
  - metric_definition 없음: n_a 유지 (의도 없음).

outcome_status 전이: n_a → pending → hit | miss
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

# internal_ops에서 지원하는 metric 이름 → 회수 키 매핑
_INTERNAL_OPS_METRICS = frozenset({"velocity", "backlog_remaining", "progress"})


def _apply_direction(actual: float, target: float, direction: str) -> str | None:
    """direction 기반 hit/miss 판정. 알 수 없는 direction → None(pending)."""
    if direction == "up":
        return "hit" if actual >= target else "miss"
    if direction == "down":
        return "hit" if actual <= target else "miss"
    return None


def _build_result(
    outcome_status: str,
    metric: Any,
    target_f: float,
    actual_f: float,
    direction: str,
    outcome_result: dict | None = None,
) -> dict[str, Any]:
    if outcome_status in ("hit", "miss"):
        return {
            "outcome_status": outcome_status,
            "outcome_result": outcome_result or {
                "metric": metric,
                "target": target_f,
                "actual": actual_f,
                "direction": direction,
                "scored_at": datetime.now(timezone.utc).isoformat(),
            },
        }
    return {"outcome_status": outcome_status, "outcome_result": None}


def score_sprint_outcome(
    metric_definition: dict[str, Any] | None,
    velocity: int,
    backlog_remaining: int,
    total_points: int,
) -> dict[str, Any] | None:
    """internal_ops 기반 채점 (close() 즉시 호출).

    Args:
        metric_definition: sprint.metric_definition JSONB
        velocity:          done story points 합산
        backlog_remaining: done 아닌 스토리 수 (close 시점)
        total_points:      sprint 전체 story_points 합산

    Returns:
        None → n_a 유지
        dict → update에 적용할 kwargs
    """
    if not metric_definition:
        return None

    source = metric_definition.get("source")
    metric = metric_definition.get("metric")
    target = metric_definition.get("target")
    direction = metric_definition.get("direction")

    if source == "ga4":
        # GA4는 지연 채점 cron에서 처리 — close 즉시엔 pending
        return {"outcome_status": "pending", "outcome_result": None}

    if source != "internal_ops":
        return {"outcome_status": "pending", "outcome_result": None}

    # metric 이름으로 actual 분기
    if metric == "velocity":
        actual_raw: float = float(velocity)
    elif metric == "backlog_remaining":
        actual_raw = float(backlog_remaining)
    elif metric == "progress":
        actual_raw = round((velocity / total_points * 100) if total_points > 0 else 0.0, 2)
    else:
        return {"outcome_status": "pending", "outcome_result": None}

    try:
        target_f = float(target)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return {"outcome_status": "pending", "outcome_result": None}

    verdict = _apply_direction(actual_raw, target_f, direction or "")
    if verdict is None:
        return {"outcome_status": "pending", "outcome_result": None}

    return _build_result(verdict, metric, target_f, actual_raw, direction)


def score_ga4_outcome(metric_definition: dict[str, Any]) -> dict[str, Any]:
    """GA4 Data API 기반 채점 (지연 cron에서 호출).

    Returns:
        dict → {'outcome_status': ..., 'outcome_result': ...}
        실패 시 → pending 반환 (인증 불가·회수 실패·데이터 없음)
    """
    property_id = metric_definition.get("property_id")
    ga4_metric = metric_definition.get("ga4_metric")
    date_range_days = metric_definition.get("date_range_days", 30)
    target = metric_definition.get("target")
    direction = metric_definition.get("direction")
    metric = metric_definition.get("metric")

    if not property_id or not ga4_metric:
        return {"outcome_status": "pending", "outcome_result": None}

    from app.services.ga4_client import fetch_ga4_metric
    actual = fetch_ga4_metric(str(property_id), str(ga4_metric), int(date_range_days))

    if actual is None:
        return {"outcome_status": "pending", "outcome_result": None}

    try:
        target_f = float(target)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return {"outcome_status": "pending", "outcome_result": None}

    verdict = _apply_direction(actual, target_f, direction or "")
    if verdict is None:
        return {"outcome_status": "pending", "outcome_result": None}

    return _build_result(verdict, metric, target_f, actual, direction)
