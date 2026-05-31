"""E-CAGE-REFEREE P3 ④: 신뢰 기반 disposition 동적 조절 추천 엔진.

추천만 — 인간 승인 후 override 적용. 자동 적용 절대 금지.
저표본 가드: verdict 부족 시 추천 안 함(책상발명 금지).
온더플라이 집계 (추가 마이그 없음).

추천 기준 (보수적 MVP):
  완화 추천: clean_pass_rate >= HIGH_THRESHOLD AND total_verdicts >= min_verdicts
             AND current_disposition != 'allow_auto'
             → allow_auto 추천
  강화 추천: clean_pass_rate < LOW_THRESHOLD AND total_verdicts >= min_verdicts
             AND current_disposition == 'allow_auto'
             → ask 추천
  그 외: 추천 없음 (데이터 더 쌓인 뒤)
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.services.gate_resolver import resolve_disposition
from app.services.trust_score import compute_member_trust_scores

DEFAULT_MIN_VERDICTS = 10  # 저표본 임계값 — 보수적 기본
HIGH_THRESHOLD = 0.90      # 완화 추천: 90% 이상 무정정 통과
LOW_THRESHOLD = 0.70       # 강화 추천: 70% 미만


async def get_disposition_recommendation(
    session: AsyncSession,
    org_id: uuid.UUID,
    member_id: uuid.UUID,
    role_id: uuid.UUID,
    role_key: str,
    gate_type: str,
    min_verdicts: int = DEFAULT_MIN_VERDICTS,
    window_days: int = 90,
) -> dict[str, Any]:
    """(member, role, gate_type)별 disposition 조정 추천.

    Args:
        role_key: participation_role.key — trust_score role 필터용
        min_verdicts: 저표본 가드 임계값

    Returns:
        {
            "has_recommendation": bool,
            "current_disposition": str,
            "recommended_disposition": str | None,
            "reason": str,
            "clean_pass_rate": float | None,
            "total_verdicts": int,
            "skipped_reason": str | None,
        }
    """
    # 1. 현재 disposition 해소
    current = await resolve_disposition(session, org_id, member_id, role_id, gate_type)

    # 2. 신뢰점수 조회
    trust = await compute_member_trust_scores(
        session=session,
        org_id=org_id,
        member_id=member_id,
        role_key=role_key,
        window_days=window_days,
    )

    role_score = next(
        (s for s in trust.get("scores", []) if s["role_key"] == role_key),
        None,
    )

    total_verdicts = role_score["total_verdicts"] if role_score else 0
    clean_pass_rate = role_score.get("clean_pass_rate") if role_score else None

    # 3. 저표본 가드
    if total_verdicts < min_verdicts:
        return {
            "has_recommendation": False,
            "current_disposition": current,
            "recommended_disposition": None,
            "reason": f"표본 부족 (verdicts={total_verdicts} < min={min_verdicts}). 더 쌓인 뒤 추천 가능.",
            "clean_pass_rate": clean_pass_rate,
            "total_verdicts": total_verdicts,
            "skipped_reason": "low_sample",
        }

    # 4. 추천 산출
    if clean_pass_rate is None:
        return {
            "has_recommendation": False,
            "current_disposition": current,
            "recommended_disposition": None,
            "reason": "clean_pass_rate 없음 (verdict 있으나 SP 데이터 없음).",
            "clean_pass_rate": None,
            "total_verdicts": total_verdicts,
            "skipped_reason": "no_rate",
        }

    # 완화 추천
    if clean_pass_rate >= HIGH_THRESHOLD and current != "allow_auto":
        return {
            "has_recommendation": True,
            "current_disposition": current,
            "recommended_disposition": "allow_auto",
            "reason": (
                f"무정정 통과율 {clean_pass_rate:.0%} ({total_verdicts}건) — "
                f"신뢰 충분, {current} → allow_auto 완화 추천."
            ),
            "clean_pass_rate": clean_pass_rate,
            "total_verdicts": total_verdicts,
            "skipped_reason": None,
        }

    # 강화 추천
    if clean_pass_rate < LOW_THRESHOLD and current == "allow_auto":
        return {
            "has_recommendation": True,
            "current_disposition": current,
            "recommended_disposition": "ask",
            "reason": (
                f"무정정 통과율 {clean_pass_rate:.0%} ({total_verdicts}건) — "
                f"통과율 하락, allow_auto → ask 강화 추천."
            ),
            "clean_pass_rate": clean_pass_rate,
            "total_verdicts": total_verdicts,
            "skipped_reason": None,
        }

    # 추천 없음
    return {
        "has_recommendation": False,
        "current_disposition": current,
        "recommended_disposition": None,
        "reason": (
            f"통과율 {clean_pass_rate:.0%} ({total_verdicts}건) — "
            f"현 disposition({current}) 적합, 조정 불필요."
        ),
        "clean_pass_rate": clean_pass_rate,
        "total_verdicts": total_verdicts,
        "skipped_reason": "no_adjustment_needed",
    }
