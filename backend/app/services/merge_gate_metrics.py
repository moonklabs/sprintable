"""H1-S9: merge verdict gate 관측 지표 on-the-fly 집계.

gate/verdict/story를 읽어 6지표를 산출한다. 신규 신설 0(읽기전용). null/0 구분: ratio는 분모 0이면
None(데이터 없음), 데이터 있고 num 0이면 0.0. throughput은 count(0=실제 무).
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import and_, case, distinct, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.gate import Gate
from app.models.participation import Participation, ParticipationRole
from app.models.pm import Story
from app.models.verdict import Verdict

_RESOLVED_MERGE_STATUSES = ("auto_passed", "approved")


def _window(stmt, col, start: datetime | None, end: datetime | None):
    if start is not None:
        stmt = stmt.where(col >= start)
    if end is not None:
        stmt = stmt.where(col <= end)
    return stmt


def _ratio(num: int | None, denom: int | None) -> float | None:
    """분모 0/None이면 None(데이터 없음), 아니면 round(num/denom, 4)."""
    if not denom:
        return None
    return round((num or 0) / denom, 4)


async def compute_merge_gate_metrics(
    session: AsyncSession,
    org_id: uuid.UUID,
    *,
    project_id: uuid.UUID | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
) -> dict[str, Any]:
    # ── 1. merge_gate_coverage = (done & merge gate 보유)/(done story) ──────────
    cov = (
        select(
            func.count(distinct(Story.id)).label("denom"),
            func.count(distinct(case((Gate.id.isnot(None), Story.id)))).label("num"),
        )
        .select_from(Story)
        .outerjoin(
            Gate,
            and_(
                Gate.work_item_id == Story.id,
                Gate.work_item_type == "story",
                Gate.gate_type == "merge",
            ),
        )
        .where(Story.org_id == org_id, Story.status == "done")
    )
    cov = _window(cov, Story.updated_at, start, end)
    if project_id is not None:
        cov = cov.where(Story.project_id == project_id)
    cov_row = (await session.execute(cov)).one()
    merge_gate_coverage = _ratio(cov_row.num, cov_row.denom)

    # ── 2. verdict_coverage = (verdict 보유 impl participation)/(impl participation) ─
    vc = (
        select(
            func.count(distinct(Participation.id)).label("denom"),
            func.count(distinct(case((Verdict.result.isnot(None), Participation.id)))).label("num"),
        )
        .select_from(Participation)
        .join(ParticipationRole, ParticipationRole.id == Participation.role_id)
        .join(Story, Story.id == Participation.story_id)
        .outerjoin(Verdict, Verdict.participation_id == Participation.id)
        .where(Participation.org_id == org_id, ParticipationRole.is_default.is_(True))
    )
    vc = _window(vc, Participation.created_at, start, end)
    if project_id is not None:
        vc = vc.where(Story.project_id == project_id)
    vc_row = (await session.execute(vc)).one()
    verdict_coverage = _ratio(vc_row.num, vc_row.denom)

    # ── 3. trustworthy_merge_throughput = auto_passed merge gate count ──────────
    tp = select(func.count(distinct(Gate.id))).where(
        Gate.org_id == org_id, Gate.gate_type == "merge", Gate.status == "auto_passed"
    )
    tp = _window(tp, Gate.created_at, start, end)
    if project_id is not None:
        tp = tp.join(Story, Story.id == Gate.work_item_id).where(Story.project_id == project_id)
    trustworthy_merge_throughput = int((await session.execute(tp)).scalar() or 0)

    # ── 4. human_review_minutes = Σ(resolved-created)/60 for 사람해소 gate ──────
    hr = select(
        (func.sum(func.extract("epoch", Gate.resolved_at - Gate.created_at)) / 60.0).label("minutes"),
        func.count(distinct(Gate.id)).label("cnt"),
    ).where(Gate.org_id == org_id, Gate.resolver_id.isnot(None), Gate.resolved_at.isnot(None))
    hr = _window(hr, Gate.resolved_at, start, end)
    if project_id is not None:
        hr = hr.join(Story, Story.id == Gate.work_item_id).where(Story.project_id == project_id)
    hr_row = (await session.execute(hr)).one()
    human_review_minutes = round(float(hr_row.minutes), 2) if hr_row.cnt else None

    # ── 5. rubber_stamp_rate = (rubber_stamp_candidate)/(사람 approve) ──────────
    rs = select(
        func.count(distinct(Gate.id)).label("denom"),
        func.count(distinct(Gate.id))
        .filter(Gate.neutral_facts["rubber_stamp_candidate"].astext == "true")
        .label("num"),
    ).where(Gate.org_id == org_id, Gate.status == "approved", Gate.resolver_id.isnot(None))
    rs = _window(rs, Gate.resolved_at, start, end)
    if project_id is not None:
        rs = rs.join(Story, Story.id == Gate.work_item_id).where(Story.project_id == project_id)
    rs_row = (await session.execute(rs)).one()
    rubber_stamp_rate = _ratio(rs_row.num, rs_row.denom)

    # ── 6. post_merge_regret_rate = (머지 해소 story 중 현재 status≠done)/(머지 해소 story) ─
    # regret 신호 = 머지(merge gate auto_passed|approved) 후 done 이탈(현재상태 proxy).
    rg = (
        select(
            func.count(distinct(Story.id)).label("denom"),
            func.count(distinct(case((Story.status != "done", Story.id)))).label("num"),
        )
        .select_from(Gate)
        .join(Story, Story.id == Gate.work_item_id)
        .where(
            Gate.org_id == org_id,
            Gate.gate_type == "merge",
            Gate.status.in_(_RESOLVED_MERGE_STATUSES),
        )
    )
    rg = _window(rg, Gate.created_at, start, end)
    if project_id is not None:
        rg = rg.where(Story.project_id == project_id)
    rg_row = (await session.execute(rg)).one()
    post_merge_regret_rate = _ratio(rg_row.num, rg_row.denom)

    return {
        "merge_gate_coverage": merge_gate_coverage,
        "verdict_coverage": verdict_coverage,
        "trustworthy_merge_throughput": trustworthy_merge_throughput,
        "human_review_minutes": human_review_minutes,
        "rubber_stamp_rate": rubber_stamp_rate,
        "post_merge_regret_rate": post_merge_regret_rate,
        "project_id": str(project_id) if project_id else None,
        "window": {
            "start": start.isoformat() if start else None,
            "end": end.isoformat() if end else None,
        },
    }
