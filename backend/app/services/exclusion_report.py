"""E-CAGE-REFEREE P1: 데이터 오염 식별 기준 + dry-run 리포트 서비스.

⚠️ 자동 대량 마킹 금지 — 이 서비스는 조회/리포트 전용.
실제 마킹은 PO 리뷰 후 PATCH /stories/{id} is_excluded=true 로 개별 적용.

식별 기준 (보수적):
  - HIGH_SP_THRESHOLD: story_points >= 50 이상 (단일 스토리로 비정상적 고SP)
  - TOP_ASSIGNEE_THRESHOLD: 단일 assignee 가 전체의 30% 이상 차지 시 리포트
    (자동 제외 아님 — 실데이터 오배제 위험 크므로 PO 판단 필요)
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pm import Story
from app.models.team import TeamMember

HIGH_SP_THRESHOLD = 50  # story_points >= 이 값이면 이상치 후보
TOP_ASSIGNEE_RATIO = 0.30  # assignee 집중도 임계치


async def generate_exclusion_report(
    session: AsyncSession,
    org_id: uuid.UUID,
    project_id: uuid.UUID | None = None,
) -> dict[str, Any]:
    """오염 후보 dry-run 리포트 — 조회 전용, 마킹 없음.

    Returns:
        {
            "total_stories": int,
            "already_excluded": int,
            "high_sp_candidates": [...],  # story_points >= HIGH_SP_THRESHOLD
            "assignee_distribution": [...],  # assignee별 건수+SP
            "criteria": {...}  # 사용한 기준 명시
        }
    """
    base_where = [
        Story.org_id == org_id,
        Story.deleted_at.is_(None),
    ]
    if project_id:
        base_where.append(Story.project_id == project_id)

    # 전체/제외 건수
    total_r = await session.execute(select(func.count(Story.id)).where(*base_where))
    total = total_r.scalar_one() or 0

    excluded_r = await session.execute(
        select(func.count(Story.id)).where(*base_where, Story.is_excluded.is_(True))
    )
    already_excluded = excluded_r.scalar_one() or 0

    # 고SP 이상치 후보 (자동 마킹 아님 — 리포트 전용)
    high_sp_r = await session.execute(
        select(Story.id, Story.title, Story.story_points, Story.assignee_id)
        .where(*base_where, Story.is_excluded.is_(False), Story.story_points >= HIGH_SP_THRESHOLD)
        .order_by(Story.story_points.desc())
        .limit(50)
    )
    high_sp_candidates = [
        {"id": str(r[0]), "title": r[1], "story_points": r[2], "assignee_id": str(r[3]) if r[3] else None}
        for r in high_sp_r.all()
    ]

    # assignee별 건수+SP 분포 (is_excluded=false만)
    dist_r = await session.execute(
        select(
            Story.assignee_id,
            func.count(Story.id).label("count"),
            func.sum(Story.story_points).label("total_sp"),
        )
        .where(*base_where, Story.is_excluded.is_(False))
        .group_by(Story.assignee_id)
        .order_by(func.count(Story.id).desc())
        .limit(20)
    )
    non_excluded_total = total - already_excluded
    assignee_distribution = [
        {
            "assignee_id": str(r[0]) if r[0] else None,
            "count": r[1],
            "total_sp": int(r[2] or 0),
            "pct": round(r[1] / non_excluded_total * 100, 1) if non_excluded_total > 0 else 0,
        }
        for r in dist_r.all()
    ]

    return {
        "total_stories": total,
        "already_excluded": already_excluded,
        "active_stories": non_excluded_total,
        "high_sp_candidates": high_sp_candidates,
        "high_sp_candidate_count": len(high_sp_candidates),
        "assignee_distribution": assignee_distribution,
        "criteria": {
            "high_sp_threshold": HIGH_SP_THRESHOLD,
            "top_assignee_ratio_threshold": TOP_ASSIGNEE_RATIO,
            "note": "리포트 전용 — 자동 마킹 없음. PO 리뷰 후 개별 PATCH로 적용",
        },
    }
