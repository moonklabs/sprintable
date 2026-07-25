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

    async def list(
        self, limit: int = 1000, *, q: str | None = None, cursor: datetime | None = None, **filters,
    ) -> list[Story]:
        """story 083176e8(까심 #2148 QA 적출): 갤러리 피커 실검색 — `q`는 title ILIKE 부분일치로
        기존 동등비교 필터(**filters, base.list() 상속)와 AND 결합. BaseRepository.list()는
        범용(모든 리포지토리 공유)이라 q ILIKE 개념을 거기 얹지 않고 story 전용으로 오버라이드
        (list_board/list_by_ids와 동일하게 자체 쿼리 구성 — 기존 관례).

        story #2189(2026-07-25): ORDER BY도 cursor도 없었다 — FE(`buildCursorPageMeta`)의
        over-fetch(limit+1) 페이지네이션은 **결정적 정렬 + cursor가 WHERE로 실제 적용**되는
        전제 위에서만 동작하는데(board 분기·현재 `/api/goals`가 이미 그 전제로 동작 중), 이
        분기만 둘 다 없어 "커서를 바꿔도 같은 페이지가 반복"됐다(sprints/standup "더 보기"가
        dedup 없이 중복 누적). board 분기와 동형으로 `created_at DESC` + `cursor` WHERE를
        추가한다 — board처럼 별도 전용 정렬 우선순위(priority)를 얹지 않는 이유는 이 분기의
        전 콜러(`buildCursorPageMeta`)가 `created_at`만 cursorField로 쓰기 때문(다른 정렬
        기준을 얹으면 FE가 계산하는 nextCursor와 실제 정렬 순서가 어긋난다).

        까심군 QA 지적(2026-07-25, #2490 머지 前): `created_at`만으로는 같은 트랜잭션 배치
        insert 시 server_default=func.now()가 여러 행에 동일 값을 줄 수 있어(테스트가 이 경계를
        1초씩 벌려 피해갔던 것 자체가 "이 경로가 시험된 적 없다"는 증거였다) ORDER BY가
        비결정적이었다 — 같은 쿼리를 다시 실행해도 동률 구간의 순서가 달라질 수 있어 페이지
        재요청 시 skip/dup 위험. `id`를 안정적 2차 키로 얹어 정렬 자체를 결정적으로 만든다
        (board의 `_PRIORITY_ORDER`를 그대로 베끼지 않는 이유: 여기 필요한 건 "board와 같은
        정렬 결과"가 아니라 "커서 전진이 결정적인 것" — 목적에 맞는 최소 키면 충분하다).

        ⚠️ 남는 한계(무너지는 조건): cursor 자체는 여전히 `created_at` 단일값이라(FE
        `buildCursorPageMeta`가 그 값만 보내는 계약 — 서버 혼자 바꿀 수 없다), 동률 경계에
        걸친 행은 이론상 다음 페이지에서 스킵될 수 있다(중복 전달보다는 덜 나쁜 실패 모드로
        의도적으로 선택). board 분기도 동일한 구조적 한계를 이미 갖고 있다 — 실제로 skip이
        관측되면 그때 복합 커서(`created_at`+`id`)로 승격한다.
        """
        query = select(Story).where(self._org_filter(), Story.deleted_at.is_(None))
        for attr, val in filters.items():
            query = query.where(getattr(Story, attr) == val)
        if q:
            query = query.where(Story.title.ilike(f"%{q}%"))
        if cursor:
            query = query.where(Story.created_at < cursor)
        query = query.order_by(Story.created_at.desc(), Story.id.desc()).limit(limit)
        result = await self.session.execute(query)
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

    async def list_backlog(self, project_id: uuid.UUID, limit: int = 1000) -> list[Story]:
        """sprint 미배정 + 삭제되지 않은 스토리만 서버사이드 필터."""
        result = await self.session.execute(
            select(Story).where(
                self._org_filter(),
                Story.project_id == project_id,
                Story.sprint_id.is_(None),
                Story.deleted_at.is_(None),
            ).limit(limit)
        )
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
