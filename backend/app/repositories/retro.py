import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.retro import PHASE_TRANSITIONS, RetroAction, RetroItem, RetroSession, RetroVote
from app.repositories.base import BaseRepository


class RetroSessionRepository(BaseRepository[RetroSession]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(RetroSession, session, org_id)

    async def advance_phase(self, id: uuid.UUID) -> RetroSession:
        retro = await self.get(id)
        if retro is None:
            raise ValueError(f"RetroSession {id} not found")
        next_phase = PHASE_TRANSITIONS.get(retro.phase)
        if next_phase is None:
            raise ValueError(f"Session is already in final phase: {retro.phase}")
        updated = await self.update(id, phase=next_phase)
        assert updated is not None
        return updated

    async def set_phase(self, id: uuid.UUID, new_phase: str) -> RetroSession:
        from app.models.retro import RETRO_PHASES
        retro = await self.get(id)
        if retro is None:
            raise ValueError(f"RetroSession {id} not found")
        current_idx = list(RETRO_PHASES).index(retro.phase)
        new_idx = list(RETRO_PHASES).index(new_phase) if new_phase in RETRO_PHASES else -1
        if new_idx < 0:
            raise ValueError(f"Invalid phase: {new_phase}")
        if new_idx != current_idx + 1:
            raise ValueError(f"Non-sequential transition: {retro.phase} → {new_phase}")
        updated = await self.update(id, phase=new_phase)
        assert updated is not None
        return updated


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


class RetroVoteRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def vote(self, item_id: uuid.UUID, voter_id: uuid.UUID) -> RetroVote:
        existing = await self.session.execute(
            select(RetroVote).where(RetroVote.item_id == item_id, RetroVote.voter_id == voter_id)
        )
        if existing.scalar_one_or_none() is not None:
            raise ValueError("DUPLICATE_VOTE")
        vote = RetroVote(item_id=item_id, voter_id=voter_id)
        self.session.add(vote)
        await self.session.flush()
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
