from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pm import Story
from app.repositories.base import BaseRepository
from app.schemas.story import STATUS_TRANSITIONS

_PRIORITY_ORDER = case(
    (Story.priority == "critical", 0),
    (Story.priority == "high", 1),
    (Story.priority == "medium", 2),
    (Story.priority == "low", 3),
    else_=4,
)


async def allocate_story_number(session: AsyncSession, project_id: uuid.UUID) -> int:
    """story 9ac9b80f(FR·대표요청): 프로젝트별 race-safe sequential #N 채번.

    advisory xact lock으로 동일 project_id 동시생성을 직렬화(recruit_service.
    acquire_agent_mutation_lock과 동형 관례) — MAX()+1은 잠금 없이는 TOCTOU(두 트랜잭션이
    같은 max를 읽어 같은 번호를 계산)에 취약하지만, 잠금이 이 함수 호출부터 caller의 커밋/롤백
    까지 동일 project_id 락을 직렬화하므로 안전. 별도 unlock 불요(트랜잭션 종료 시 자동 해제).
    caller는 이 호출과 실제 INSERT를 **같은 트랜잭션**(같은 session, 중간 commit 없음)에서
    수행해야 한다."""
    await session.execute(
        select(func.pg_advisory_xact_lock(func.hashtext(f"story_number:{project_id}")))
    )
    result = await session.execute(
        select(func.coalesce(func.max(Story.story_number), 0)).where(Story.project_id == project_id)
    )
    return int(result.scalar_one()) + 1


class StoryRepository(BaseRepository[Story]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(Story, session, org_id)

    async def create(self, **data) -> Story:
        """story 9ac9b80f: story_number는 client-settable 아님 — 항상 서버가 project_id로
        allocate_story_number 호출해 채번한다(BaseRepository.create 전 오버라이드)."""
        story_number = await allocate_story_number(self.session, data["project_id"])
        return await super().create(story_number=story_number, **data)

    async def list(self, limit: int = 1000, *, q: str | None = None, **filters) -> list[Story]:
        """story 083176e8(까심 #2148 QA 적출): 갤러리 피커 실검색 — `q`는 title ILIKE 부분일치로
        기존 동등비교 필터(**filters, base.list() 상속)와 AND 결합. BaseRepository.list()는
        범용(모든 리포지토리 공유)이라 q ILIKE 개념을 거기 얹지 않고 story 전용으로 오버라이드
        (list_board/list_by_ids와 동일하게 자체 쿼리 구성 — 기존 관례).
        """
        query = select(Story).where(self._org_filter(), Story.deleted_at.is_(None))
        for attr, val in filters.items():
            query = query.where(getattr(Story, attr) == val)
        if q:
            query = query.where(Story.title.ilike(f"%{q}%"))
        result = await self.session.execute(query.limit(limit))
        return list(result.scalars().all())

    async def list_by_ids(self, ids: list[uuid.UUID]) -> list[Story]:
        """배치 앵커 조회(story ca37b2b0 ② — 갤러리 등 정확한 story 집합 필요 소비자용).

        org-scoped exact-id IN 조회. ORDER BY 없음 — 호출자가 id 집합 그대로를 필요로 하는
        용도(base.list()의 "첫 N건" 비결정 순서 문제와 무관, id 정확 매칭이라 순서 개념 자체가 없음).
        """
        if not ids:
            return []
        result = await self.session.execute(
            select(Story).where(
                self._org_filter(), Story.id.in_(ids), Story.deleted_at.is_(None),
            )
        )
        return list(result.scalars().all())

    async def list_board(
        self,
        project_id: uuid.UUID,
        status: str,
        limit: int = 20,
        cursor: datetime | None = None,
        sprint_id: uuid.UUID | None = None,
        assignee_id: uuid.UUID | None = None,
        epic_id: uuid.UUID | None = None,
        story_number: int | None = None,
        q_text: str | None = None,
    ) -> tuple[list[Story], int]:
        """CB-S4: 보드 상태별 쿼리 — created_at DESC + priority 보조 정렬 + cursor 페이징.

        done: 최근 7일 + limit 10 고정.

        story #2188(2026-07-25, 오르테가군 도그푸딩 적발): epic_id/story_number/q_text는
        list_stories()의 제네릭 필터 블록(:148 이하)에만 있고 이 board 분기엔 없었다 — status+
        project_id 조합이면 이 분기로 빠지면서 나머지 필터가 조용히 무시돼 "필터를 추가했는데
        결과가 늘어나는"(계약 위반) 결과를 냈다. 필터는 좁히기만 해야 한다는 불변식을
        test_2188_list_stories_filter_monotonicity.py로 고정한다.
        """
        q = select(Story).where(
            self._org_filter(),
            Story.project_id == project_id,
            Story.status == status,
            Story.deleted_at.is_(None),
        )
        if sprint_id:
            q = q.where(Story.sprint_id == sprint_id)
        if assignee_id:
            q = q.where(Story.assignee_id == assignee_id)
        if epic_id:
            q = q.where(Story.epic_id == epic_id)
        if story_number is not None:
            q = q.where(Story.story_number == story_number)
        if q_text:
            q = q.where(Story.title.ilike(f"%{q_text}%"))

        # done: 최근 7일 제한
        if status == "done":
            cutoff = datetime.now(timezone.utc) - timedelta(days=7)
            q = q.where(Story.created_at >= cutoff)
            limit = min(limit, 10)

        # cursor 기반 페이징 (created_at < cursor)
        if cursor:
            q = q.where(Story.created_at < cursor)

        count_q = select(func.count()).select_from(q.subquery())
        total = (await self.session.execute(count_q)).scalar_one()

        q = q.order_by(Story.created_at.desc(), _PRIORITY_ORDER).limit(limit)
        stories = list((await self.session.execute(q)).scalars().all())
        return stories, total

    async def list_backlog(
        self,
        project_id: uuid.UUID,
        limit: int = 1000,
        epic_id: uuid.UUID | None = None,
        assignee_id: uuid.UUID | None = None,
        status: str | None = None,
        story_number: int | None = None,
        q: str | None = None,
    ) -> list[Story]:
        """sprint 미배정 + 삭제되지 않은 스토리만 서버사이드 필터.

        story #2188 형제(2026-07-25, 오르테가군 판정) — board 분기(#2489)와 같은 결함 클래스:
        이 분기도 epic_id/assignee_id/status/story_number/q를 받기만 하고 무시했다. 필터
        드롭 자체는 라이브 콜러 확認 결과 사용자 피해 0(FE `ApiStoryRepository.backlog()`는
        콜러 0인 죽은 코드, MCP `sprintable_list_backlog` 툴 스키마는 project_id만 받아 문제
        파라미터를 애초에 못 보냄) — 다만 REST를 직접 부르는 임시 조회(디디군이 #2188 조사
        중 실제로 걸린 자리)는 그대로 노출돼 판단 근거를 오염시킬 수 있어 medium으로 고친다.

        ⚠️ cursor는 여기 없다 — 2026-07-25 초안에서 #2190(까심군 QA)을 근거로 cursor+id
        tiebreak을 여기 얹었었으나, 오르테가군이 프록시 코드(`apps/web/src/app/api/stories/
        backlog/route.ts`)를 직접 읽고 정정: 그 프록시가 `status=backlog`를 강제 부착해
        FastAPI로 보내므로 백엔드에서는 실제로 **board 분기**(`list_board`, cursor 이미 지원)
        를 타지 이 분기로 안 온다. "URL이 `/stories/backlog`니까 이 분기겠지"로 단정한 게
        오판 원인이었다 — #2190의 진짜 원인은 그 프록시가 `apiSuccess()`에 meta를 안 넘겨
        `hasMore`가 구조적으로 항상 false인 것(다른 층의 결함)이라 이 메서드와 무관하다.
        """
        query = select(Story).where(
            self._org_filter(),
            Story.project_id == project_id,
            Story.sprint_id.is_(None),
            Story.deleted_at.is_(None),
        )
        if epic_id:
            query = query.where(Story.epic_id == epic_id)
        if assignee_id:
            query = query.where(Story.assignee_id == assignee_id)
        if status:
            query = query.where(Story.status == status)
        if story_number is not None:
            query = query.where(Story.story_number == story_number)
        if q:
            query = query.where(Story.title.ilike(f"%{q}%"))
        result = await self.session.execute(query.limit(limit))
        return list(result.scalars().all())

    async def transition_status(self, id: uuid.UUID) -> Story:
        story = await self.get(id)
        if story is None:
            raise ValueError(f"Story {id} not found")
        next_status = STATUS_TRANSITIONS.get(story.status)
        if next_status is None:
            raise ValueError(f"No forward transition from status: {story.status}")
        updated = await self.update(id, status=next_status)
        assert updated is not None
        return updated

    async def set_status(
        self, id: uuid.UUID, new_status: str, violation_level: str = "warn"
    ) -> Story:
        story = await self.get(id)
        if story is None:
            raise ValueError(f"Story {id} not found")

        from app.schemas.story import STORY_STATUSES
        if new_status not in STORY_STATUSES:
            raise ValueError(f"Invalid status: {new_status}")

        if new_status == story.status:
            return story

        current_idx = list(STORY_STATUSES).index(story.status)
        new_idx = list(STORY_STATUSES).index(new_status)
        if new_idx != current_idx + 1:
            # AC1: warn 모드이면 hard block 우회 → 전이 허용 (violation 이벤트는 caller에서 발행)
            if violation_level != "warn":
                raise ValueError(
                    f"Non-sequential transition not allowed: {story.status} → {new_status}"
                )

        updated = await self.update(id, status=new_status)
        assert updated is not None
        return updated
