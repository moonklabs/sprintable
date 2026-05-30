"""E-OUTCOME-LOOP S5: GA4 Data API 클라이언트.

서비스계정 인증 (GOOGLE_APPLICATION_CREDENTIALS 환경변수 또는 ADC).
property_id 파라미터화 — 권한과 독립적으로 구현.
"""
from __future__ import annotations

import logging
import os
from datetime import date, timedelta
from typing import Any

logger = logging.getLogger(__name__)


def _make_date_range(date_range_days: int) -> tuple[str, str]:
    """date_range_days일 전 ~ 어제 (GA4 데이터 지연 고려)."""
    end = date.today() - timedelta(days=1)
    start = end - timedelta(days=date_range_days - 1)
    return start.isoformat(), end.isoformat()


def fetch_ga4_metric(
    property_id: str,
    ga4_metric: str,
    date_range_days: int,
) -> float | None:
    """GA4 Data API runReport로 단일 지표 값 회수.

    Args:
        property_id:    GA4 property ID (예: "291556226")
        ga4_metric:     GA4 지표명 (예: "activeUsers")
        date_range_days: 회수 기간 (일수)

    Returns:
        float 또는 None (인증 불가 / 데이터 없음 / 오류)
    """
    # ADC 또는 GOOGLE_APPLICATION_CREDENTIALS 미설정 시 None 반환 (pending 처리)
    creds_file = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not creds_file and not _has_adc():
        logger.warning("ga4_client: 인증 정보 없음 → pending 처리 (property_id=%s)", property_id)
        return None

    try:
        from google.analytics.data_v1beta import BetaAnalyticsDataClient
        from google.analytics.data_v1beta.types import (
            DateRange,
            Dimension,
            Metric,
            RunReportRequest,
        )

        client = BetaAnalyticsDataClient()
        start_date, end_date = _make_date_range(date_range_days)

        request = RunReportRequest(
            property=f"properties/{property_id}",
            metrics=[Metric(name=ga4_metric)],
            date_ranges=[DateRange(start_date=start_date, end_date=end_date)],
        )
        response = client.run_report(request)

        if not response.rows:
            logger.info("ga4_client: 데이터 없음 (property=%s, metric=%s)", property_id, ga4_metric)
            return 0.0

        value_str = response.rows[0].metric_values[0].value
        return float(value_str)

    except Exception as exc:
        logger.warning(
            "ga4_client: 회수 실패 property=%s metric=%s: %s",
            property_id, ga4_metric, exc,
        )
        return None


def _has_adc() -> bool:
    """Application Default Credentials 사용 가능 여부 간단 체크."""
    try:
        import google.auth  # type: ignore[import-untyped]
        google.auth.default()
        return True
    except Exception:
        return False
