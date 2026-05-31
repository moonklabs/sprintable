"""E-CAGE-REFEREE P2: 신뢰 점수 집계 엔진.

(member, role)별 무정정 통과율 × SP 가중.
  - 무정정 통과 = verdict.result='pass' AND (rounds IS NULL OR rounds=0)
  - SP 가중 = story_points (null→1 fallback). is_excluded 스토리 제외.
  - 온더플라이 집계 (마이그 없음) — verdict 조인 쿼리.
  - outcome(hit/miss)은 포함 안 함 — 효과≠실행품질.
  - 빈데이터 graceful: verdict 없으면 score=None (0 아님, 구분 필요).
  - MVP 이진 산식. 데이터 쌓인 뒤 튜닝.

반환 구조:
  {
      "member_id": uuid,
      "scores": [
          {
              "role_key": str,
              "role_label": str,
              "clean_pass_verdicts": int,
              "total_verdicts": int,
              "clean_pass_rate": float | None,
              "total_sp": int,
              "clean_sp": int,
              "weighted_score": float | None,
          },
          ...
      ]
  }
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.participation import Participation, ParticipationRole
from app.models.pm import Story
from app.models.verdict import Verdict

DEFAULT_WINDOW_DAYS = 90


def _is_clean_pass(result: str | None, rounds: int | None) -> bool:
    """무정정 통과 판정: pass + 정정 라운드 없음."""
    return result == "pass" and (rounds is None or rounds == 0)


async def compute_member_trust_scores(
    session: AsyncSession,
    org_id: uuid.UUID,
    member_id: uuid.UUID,
    role_key: str | None = None,
    window_days: int = DEFAULT_WINDOW_DAYS,
) -> dict[str, Any]:
    """(member, role)별 신뢰점수 온더플라이 집계.

    Args:
        role_key: 특정 역할만 집계. None이면 전 역할.
        window_days: verdict 기준 최근 N일 윈도우.

    Returns:
        {"member_id": ..., "scores": [...], "window_days": ..., "computed_at": ...}
    """
    window_start = datetime.now(timezone.utc) - timedelta(days=window_days)

    # 1. 조회: (participation, story, role, verdict) 조인
    p_q = (
        select(Participation, Story, ParticipationRole)
        .join(Story, Story.id == Participation.story_id)
        .join(ParticipationRole, ParticipationRole.id == Participation.role_id)
        .where(
            Participation.org_id == org_id,
            Participation.member_id == member_id,
            Story.is_excluded.is_(False),
            Story.deleted_at.is_(None),
        )
    )
    if role_key is not None:
        p_q = p_q.where(ParticipationRole.key == role_key)

    p_result = await session.execute(p_q)
    rows = p_result.all()

    if not rows:
        return {
            "member_id": str(member_id),
            "scores": [],
            "window_days": window_days,
        }

    # participation_id → (story_points, role_key, role_label) 매핑
    p_map: dict[uuid.UUID, dict] = {}
    for p, s, r in rows:
        p_map[p.id] = {
            "story_points": s.story_points or 1,
            "role_key": r.key,
            "role_label": r.label,
        }

    # 2. 해당 participation들의 verdict 조회 (윈도우 내)
    verdict_r = await session.execute(
        select(Verdict).where(
            Verdict.org_id == org_id,
            Verdict.participation_id.in_(list(p_map.keys())),
            Verdict.recorded_at >= window_start,
        )
    )
    verdicts = verdict_r.scalars().all()

    # 3. role별 집계
    role_buckets: dict[str, dict] = {}
    for p_id, meta in p_map.items():
        rk = meta["role_key"]
        if rk not in role_buckets:
            role_buckets[rk] = {
                "role_key": rk,
                "role_label": meta["role_label"],
                "clean_pass_verdicts": 0,
                "total_verdicts": 0,
                "clean_sp": 0,
                "total_sp": 0,
            }

    for v in verdicts:
        meta = p_map.get(v.participation_id)
        if meta is None:
            continue
        rk = meta["role_key"]
        sp = meta["story_points"]
        bucket = role_buckets[rk]
        bucket["total_verdicts"] += 1
        bucket["total_sp"] += sp
        if _is_clean_pass(v.result, v.rounds):
            bucket["clean_pass_verdicts"] += 1
            bucket["clean_sp"] += sp

    # 4. 점수 계산
    scores: list[dict[str, Any]] = []
    for rk, b in role_buckets.items():
        tv = b["total_verdicts"]
        tsp = b["total_sp"]
        cp = b["clean_pass_verdicts"]
        csp = b["clean_sp"]

        clean_pass_rate: float | None = (cp / tv) if tv > 0 else None
        weighted_score: float | None = (csp / tsp) if tsp > 0 else None

        scores.append({
            "role_key": b["role_key"],
            "role_label": b["role_label"],
            "clean_pass_verdicts": cp,
            "total_verdicts": tv,
            "clean_pass_rate": round(clean_pass_rate, 4) if clean_pass_rate is not None else None,
            "total_sp": tsp,
            "clean_sp": csp,
            "weighted_score": round(weighted_score, 4) if weighted_score is not None else None,
        })

    return {
        "member_id": str(member_id),
        "scores": scores,
        "window_days": window_days,
    }
