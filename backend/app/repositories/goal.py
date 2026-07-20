import uuid
from collections.abc import Sequence
from datetime import datetime
from typing import Any

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hypothesis import Hypothesis, HypothesisEpicLink
from app.models.pm import Goal, Story
from app.repositories.base import BaseRepository
from app.schemas.goal import GoalProgressResponse

# risky_status 우선순위: 최위험(falsified) → 최저위험(archived). 인덱스가 곧 rank.
_RISK_ORDER: tuple[str, ...] = (
    "falsified",
    "measuring",
    "active",
    "proposed",
    "verified",
    "killed",
    "archived",
)


class GoalRepository(BaseRepository[Goal]):
    """계층 리네이밍 B1(story 1925): 구 EpicRepository — 클래스명만 rename. FK 컬럼
    (Story.epic_id·HypothesisEpicLink.epic_id)은 B4 후속 스코프라 그대로 사용."""

    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(Goal, session, org_id)

    async def list_paginated(
        self,
        *,
        limit: int | None = None,
        cursor: datetime | None = None,
        order_by: str = "created_at",
        **filters: Any,
    ) -> tuple[list[Goal], int]:
        """기본 페이지네이션 + 연결 가설 집계(hypothesis_count·risky_status) + 스토리 집계
        (total_stories·done_stories) 부착.

        E-GLANCE wedge #2(story 96b19bc3) §1.3: order_by="position"은 옵트인 로드맵 조타
        정렬 — (position IS NULL) ASC, position ASC, created_at DESC 복합 규칙이라 BaseRepository의
        단조-컬럼 cursor 메커니즘(datetime 비교)과 shape가 달라 별도 경로로 처리한다(cursor
        파라미터는 이 모드에서 미지원 — v1 스코프, #2056 기본 정렬 경로는 완전 무변경).
        """
        if order_by == "position":
            goals, total = await self._list_paginated_by_position(limit=limit, **filters)
        else:
            goals, total = await super().list_paginated(
                limit=limit, cursor=cursor, order_by=order_by, **filters
            )
        await self._attach_hypothesis_aggregates(goals)
        await self._attach_story_aggregates(goals)
        return goals, total

    async def _list_paginated_by_position(
        self, *, limit: int | None, **filters: Any,
    ) -> tuple[list[Goal], int]:
        conds = [self._org_filter()]
        for attr, val in filters.items():
            conds.append(getattr(Goal, attr) == val)

        count_result = await self.session.execute(
            select(func.count()).select_from(Goal).where(*conds)
        )
        total = int(count_result.scalar_one() or 0)

        q = (
            select(Goal).where(*conds)
            .order_by(Goal.position.is_(None).asc(), Goal.position.asc(), Goal.created_at.desc())
            .limit(limit if limit is not None else 1000)
        )
        result = await self.session.execute(q)
        return list(result.scalars().all()), total

    async def _attach_hypothesis_aggregates(self, goals: Sequence[Goal]) -> None:
        """페이지 전체 goal의 연결 가설 수/최위험 상태를 단일 쿼리로 집계해 부착.

        N+1 회피: epic_id IN (page) GROUP BY로 1회 집계. risky_status는 위험도
        rank의 MIN을 골라 다시 상태명으로 환원. 링크/가설이 없으면 count 0·risky
        None. 비-매핑 인스턴스 속성이라 읽기 경로에서 flush 영향 없음.
        """
        for goal in goals:
            goal.hypothesis_count = 0  # type: ignore[attr-defined]
            goal.risky_status = None  # type: ignore[attr-defined]
        if not goals:
            return

        goal_ids = [goal.id for goal in goals]
        rank_case = case(
            *[(Hypothesis.status == status, rank) for rank, status in enumerate(_RISK_ORDER)],
            else_=len(_RISK_ORDER),
        )
        result = await self.session.execute(
            select(
                HypothesisEpicLink.epic_id.label("epic_id"),
                func.count(func.distinct(HypothesisEpicLink.hypothesis_id)).label("cnt"),
                func.min(rank_case).label("risk_rank"),
            )
            .join(Hypothesis, Hypothesis.id == HypothesisEpicLink.hypothesis_id)
            .where(
                HypothesisEpicLink.epic_id.in_(goal_ids),
                Hypothesis.org_id == self.org_id,
            )
            .group_by(HypothesisEpicLink.epic_id)
        )
        by_goal = {row.epic_id: row for row in result.all()}
        for goal in goals:
            row = by_goal.get(goal.id)
            if row is None:
                continue
            goal.hypothesis_count = int(row.cnt or 0)  # type: ignore[attr-defined]
            rank = row.risk_rank
            if rank is not None and 0 <= rank < len(_RISK_ORDER):
                goal.risky_status = _RISK_ORDER[rank]  # type: ignore[attr-defined]

    async def _attach_story_aggregates(self, goals: Sequence[Goal]) -> None:
        """페이지 전체 goal의 연결 스토리 수(total/done)를 단일 쿼리로 집계해 부착.

        N+1 회피: epic_id IN (page) GROUP BY로 1회 집계(get_progress 집계 SQL 동형).
        deleted_at IS NULL·org 스코프. 스토리 없으면 0/0. 비-매핑 인스턴스 속성이라
        읽기 경로에서 flush 영향 없음. FE 목표 카드(total/done) 바인딩용 — stories
        배열은 부착 안 함(payload bloat 방지·detail은 별도 /progress 유지).
        """
        for goal in goals:
            goal.total_stories = 0  # type: ignore[attr-defined]
            goal.done_stories = 0  # type: ignore[attr-defined]
        if not goals:
            return

        goal_ids = [goal.id for goal in goals]
        result = await self.session.execute(
            select(
                Story.epic_id.label("epic_id"),
                func.count(Story.id).label("total_stories"),
                func.count(Story.id).filter(Story.status == "done").label("done_stories"),
            )
            .where(
                Story.epic_id.in_(goal_ids),
                Story.org_id == self.org_id,
                Story.deleted_at.is_(None),
            )
            .group_by(Story.epic_id)
        )
        by_goal = {row.epic_id: row for row in result.all()}
        for goal in goals:
            row = by_goal.get(goal.id)
            if row is None:
                continue
            goal.total_stories = int(row.total_stories or 0)  # type: ignore[attr-defined]
            goal.done_stories = int(row.done_stories or 0)  # type: ignore[attr-defined]

    async def get_progress(self, id: uuid.UUID) -> GoalProgressResponse:
        result = await self.session.execute(
            select(
                func.count(Story.id).label("total_stories"),
                func.sum(Story.story_points).label("total_sp"),
                func.count(Story.id).filter(Story.status == "done").label("done_stories"),
                func.sum(Story.story_points).filter(Story.status == "done").label("done_sp"),
            ).where(
                Story.epic_id == id,
                Story.deleted_at.is_(None),
            )
        )
        row = result.one()
        total_stories = row.total_stories or 0
        done_stories = row.done_stories or 0
        total_sp = int(row.total_sp or 0)
        done_sp = int(row.done_sp or 0)
        completion_pct = round((done_sp / total_sp) * 100) if total_sp > 0 else 0

        return GoalProgressResponse(
            goal_id=id,
            total_stories=total_stories,
            done_stories=done_stories,
            total_sp=total_sp,
            done_sp=done_sp,
            completion_pct=completion_pct,
        )
