import uuid
from typing import Any

from sqlalchemy import func, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.retro import (
    ALLOWED_PHASE_TRANSITIONS,
    RETRO_PHASES,
    RetroAction,
    RetroItem,
    RetroSession,
    RetroVote,
)
from app.repositories.base import BaseRepository


class RetroSessionRepository(BaseRepository[RetroSession]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(RetroSession, session, org_id)

    async def set_phase(self, id: uuid.UUID, new_phase: str) -> RetroSession:
        """B1: 인접 양방향(collect↔vote↔action) + action→closed 편도만 허용. closed는
        terminal(전이 0건). 같은 phase 재지정은 no-op(멱등 — FE advance 확인 다이얼로그가
        중복 클릭해도 안전)."""
        retro = await self.get(id)
        if retro is None:
            raise ValueError(f"RetroSession {id} not found")
        if new_phase not in RETRO_PHASES:
            raise ValueError(f"Invalid phase: {new_phase}")
        if new_phase == retro.phase:
            return retro
        allowed = ALLOWED_PHASE_TRANSITIONS.get(retro.phase, frozenset())
        if new_phase not in allowed:
            raise ValueError(f"Invalid phase transition: {retro.phase} → {new_phase}")
        updated = await self.update(id, phase=new_phase)
        assert updated is not None
        return updated

    async def get_for_update(self, id: uuid.UUID) -> RetroSession | None:
        """ecc531ce(까심 crux 2026-07-03) — 동시 [채택] 더블클릭 시 둘 다 next_hypotheses의
        "미채택" 상태를 읽고 각자 create_hypothesis를 호출하면 중복 proposed 가설이 생긴다
        (#1862 set_sprint_link TOCTOU와 같은 클래스). `FOR UPDATE`로 이 세션 row를 잠가
        두 번째 요청이 첫 번째 커밋 후에야 읽도록 직렬화 — check-then-insert가 아니라
        "이미 존재하는 row의 필드"를 다루는 경우라 SELECT FOR UPDATE가 유효하다
        (check_then_insert_toctou 메모의 "row 0 시점 무력" 케이스와 다름 — 여기 row는 항상 존재).

        `execution_options(populate_existing=True)` 필수 — 이 세션이 `_require_retro_project_
        access`에서 이미 같은 id로 언락 SELECT를 한 번 했다면 identity map에 그 객체가 캐싱돼
        있어, FOR UPDATE가 DB 레벨 락은 정확히 걸어도(실측 확인) SQLAlchemy가 Python 객체
        속성을 새로 fetch한 row로 갱신 안 하면 잠금 대기 후에도 여전히 "잠금 전" 값(stale
        next_hypotheses)을 반환하는 조용한 버그가 난다 — 락은 걸렸는데 읽은 값은 옛날 것이라
        원자성이 실효 없어지는 것. 원 구현(populate_existing 누락)에서 실 동시성 테스트로
        재현·적발."""
        result = await self.session.execute(
            select(RetroSession)
            .where(RetroSession.id == id, RetroSession.org_id == self.org_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return result.scalar_one_or_none()


class RetroItemRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list_by_session(self, session_id: uuid.UUID) -> list[RetroItem]:
        result = await self.session.execute(
            select(RetroItem).where(RetroItem.session_id == session_id).order_by(RetroItem.created_at)
        )
        return list(result.scalars().all())

    async def create(self, **data: Any) -> RetroItem:
        item = RetroItem(**data)
        self.session.add(item)
        await self.session.flush()
        await self.session.refresh(item)
        return item

    async def delete(self, item_id: uuid.UUID) -> bool:
        result = await self.session.execute(select(RetroItem).where(RetroItem.id == item_id))
        item = result.scalar_one_or_none()
        if item is None:
            return False
        await self.session.delete(item)
        await self.session.flush()
        return True

    async def delete_from_session(self, session_id: uuid.UUID, item_id: uuid.UUID) -> bool:
        """item_id가 session_id 소속인지 원자적으로 확인 후 삭제(session IDOR 2차 방어 — item_id를
        타 session 것으로 조작해 부모 session project-access 체크만 우회하는 것 차단)."""
        result = await self.session.execute(
            select(RetroItem).where(RetroItem.id == item_id, RetroItem.session_id == session_id)
        )
        item = result.scalar_one_or_none()
        if item is None:
            return False
        await self.session.delete(item)
        await self.session.flush()
        return True

    async def _refresh_vote_count(self, item_id: uuid.UUID) -> None:
        """vote_count를 retro_votes 실측 COUNT로 재계산(그룹핑 시 vote 이관 후 정합 보정용)."""
        count_subq = select(func.count(RetroVote.id)).where(RetroVote.item_id == item_id).scalar_subquery()
        await self.session.execute(
            update(RetroItem).where(RetroItem.id == item_id).values(vote_count=count_subq)
        )

    async def group_under_parent(
        self, session_id: uuid.UUID, item_id: uuid.UUID, parent_item_id: uuid.UUID
    ) -> RetroItem:
        """B2: child를 parent 아래 병합 — child의 기존 투표는 parent로 이관(같은 voter 중복은
        dedupe), child.vote_count=0, parent.vote_count는 이관 후 실측 재계산.

        체인 방지: parent는 반드시 top-level(parent_item_id IS NULL)이어야 함 — 같은 테이블 자기
        참조라 DB CHECK로 표현 불가, 여기서 app-level 검증."""
        if item_id == parent_item_id:
            raise ValueError("ITEM_CANNOT_GROUP_UNDER_SELF")

        child = (
            await self.session.execute(
                select(RetroItem).where(RetroItem.id == item_id, RetroItem.session_id == session_id)
            )
        ).scalar_one_or_none()
        parent = (
            await self.session.execute(
                select(RetroItem).where(
                    RetroItem.id == parent_item_id, RetroItem.session_id == session_id
                )
            )
        ).scalar_one_or_none()
        if child is None or parent is None:
            raise ValueError("ITEM_NOT_FOUND")
        if child.parent_item_id is not None:
            raise ValueError("ITEM_ALREADY_GROUPED")
        if parent.parent_item_id is not None:
            raise ValueError("PARENT_MUST_BE_TOP_LEVEL")
        if child.category != parent.category:
            raise ValueError("CATEGORY_MISMATCH")

        # 같은 voter가 child·parent 양쪽에 투표했으면 parent에 남은 1표만 유지(dedupe).
        await self.session.execute(
            text(
                """
                DELETE FROM retro_votes child_votes
                USING retro_votes parent_votes
                WHERE child_votes.item_id = :item_id
                  AND parent_votes.item_id = :parent_item_id
                  AND parent_votes.voter_id = child_votes.voter_id
                """
            ),
            {"item_id": item_id, "parent_item_id": parent_item_id},
        )
        await self.session.execute(
            update(RetroVote).where(RetroVote.item_id == item_id).values(item_id=parent_item_id)
        )

        child.parent_item_id = parent_item_id
        child.vote_count = 0
        await self._refresh_vote_count(parent_item_id)
        await self.session.flush()
        await self.session.refresh(child)
        return child

    async def ungroup(self, session_id: uuid.UUID, item_id: uuid.UUID) -> RetroItem | None:
        """child를 parent에서 분리 — 투표는 이관하지 않음(그룹핑 상태의 vote_count만 정합 유지가
        목표. child는 병합 시점에 vote_count=0으로 리셋됐고 이후 투표 불가였으므로 분리 후에도 0)."""
        item = (
            await self.session.execute(
                select(RetroItem).where(RetroItem.id == item_id, RetroItem.session_id == session_id)
            )
        ).scalar_one_or_none()
        if item is None:
            return None
        item.parent_item_id = None
        await self.session.flush()
        await self.session.refresh(item)
        return item


class RetroVoteRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def vote(self, item_id: uuid.UUID, voter_id: uuid.UUID) -> RetroVote:
        """중복투표 app-level pre-check(빠른 경로) + DB unique(item_id,voter_id) 제약(레이스
        방지 — 동시 투표 시 둘 다 pre-check 통과 가능). IntegrityError는 반드시 SAVEPOINT
        (begin_nested) 안에서만 catch — 아니면 async 세션이 poison돼 후속 write가
        PendingRollbackError(이 레포 기존 교훈: E-DG S3 P0-1)."""
        existing = await self.session.execute(
            select(RetroVote).where(RetroVote.item_id == item_id, RetroVote.voter_id == voter_id)
        )
        if existing.scalar_one_or_none() is not None:
            raise ValueError("DUPLICATE_VOTE")
        vote = RetroVote(item_id=item_id, voter_id=voter_id)
        try:
            async with self.session.begin_nested():
                self.session.add(vote)
                await self.session.flush()
        except IntegrityError as exc:
            raise ValueError("DUPLICATE_VOTE") from exc
        await self.session.execute(
            update(RetroItem).where(RetroItem.id == item_id).values(vote_count=RetroItem.vote_count + 1)
        )
        await self.session.refresh(vote)
        return vote


class RetroActionRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list_by_session(self, session_id: uuid.UUID) -> list[RetroAction]:
        result = await self.session.execute(
            select(RetroAction).where(RetroAction.session_id == session_id).order_by(RetroAction.created_at)
        )
        return list(result.scalars().all())

    async def create(self, **data: Any) -> RetroAction:
        action = RetroAction(**data)
        self.session.add(action)
        await self.session.flush()
        await self.session.refresh(action)
        return action

    async def get(self, action_id: uuid.UUID) -> RetroAction | None:
        result = await self.session.execute(select(RetroAction).where(RetroAction.id == action_id))
        return result.scalar_one_or_none()

    async def update(self, action_id: uuid.UUID, **data: Any) -> RetroAction | None:
        from sqlalchemy import update
        await self.session.execute(
            update(RetroAction).where(RetroAction.id == action_id).values(**data)
        )
        return await self.get(action_id)

    async def update_in_session(
        self, session_id: uuid.UUID, action_id: uuid.UUID, **data: Any
    ) -> RetroAction | None:
        """action_id가 session_id 소속인지 원자적으로 확인 후 갱신(session IDOR 2차 방어 —
        action_id를 타 session 것으로 조작해 부모 session project-access 체크만 우회하는 것 차단)."""
        action = (
            await self.session.execute(
                select(RetroAction).where(
                    RetroAction.id == action_id, RetroAction.session_id == session_id
                )
            )
        ).scalar_one_or_none()
        if action is None:
            return None
        for key, value in data.items():
            setattr(action, key, value)
        await self.session.flush()
        await self.session.refresh(action)
        return action
