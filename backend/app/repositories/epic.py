import uuid
from collections.abc import Sequence
from datetime import datetime
from typing import Any

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hypothesis import Hypothesis, HypothesisEpicLink
from app.models.pm import Epic, Story
from app.repositories.base import BaseRepository
from app.schemas.epic import EpicProgressResponse

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


class EpicRepository(BaseRepository[Epic]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(Epic, session, org_id)

    async def list_paginated(
        self,
        *,
        limit: int | None = None,
        cursor: datetime | None = None,
        order_by: str = "created_at",
        **filters: Any,
    ) -> tuple[list[Epic], int]:
        """기본 페이지네이션 + 연결 가설 집계(hypothesis_count·risky_status) 부착."""
        epics, total = await super().list_paginated(
            limit=limit, cursor=cursor, order_by=order_by, **filters
        )
        await self._attach_hypothesis_aggregates(epics)
        return epics, total

    async def _attach_hypothesis_aggregates(self, epics: Sequence[Epic]) -> None:
        """페이지 전체 epic의 연결 가설 수/최위험 상태를 단일 쿼리로 집계해 부착.

        N+1 회피: epic_id IN (page) GROUP BY로 1회 집계. risky_status는 위험도
        rank의 MIN을 골라 다시 상태명으로 환원. 링크/가설이 없으면 count 0·risky
        None. 비-매핑 인스턴스 속성이라 읽기 경로에서 flush 영향 없음.
        """
        for epic in epics:
            epic.hypothesis_count = 0  # type: ignore[attr-defined]
            epic.risky_status = None  # type: ignore[attr-defined]
        if not epics:
            return

        epic_ids = [epic.id for epic in epics]
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
                HypothesisEpicLink.epic_id.in_(epic_ids),
                Hypothesis.org_id == self.org_id,
            )
            .group_by(HypothesisEpicLink.epic_id)
        )
        by_epic = {row.epic_id: row for row in result.all()}
        for epic in epics:
            row = by_epic.get(epic.id)
            if row is None:
                continue
            epic.hypothesis_count = int(row.cnt or 0)  # type: ignore[attr-defined]
            rank = row.risk_rank
            if rank is not None and 0 <= rank < len(_RISK_ORDER):
                epic.risky_status = _RISK_ORDER[rank]  # type: ignore[attr-defined]

    async def get_progress(self, id: uuid.UUID) -> EpicProgressResponse:
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

        return EpicProgressResponse(
            epic_id=id,
            total_stories=total_stories,
            done_stories=done_stories,
            total_sp=total_sp,
            done_sp=done_sp,
            completion_pct=completion_pct,
        )
