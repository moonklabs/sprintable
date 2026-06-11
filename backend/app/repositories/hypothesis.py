"""E1-S2: Hypothesis repository — CRUD(BaseRepository) + epic/story 링크 테이블.

링크 테이블(hypothesis_epic_links·hypothesis_story_links)은 org_id가 없어
BaseRepository의 tenant 주입을 쓰지 않고 plain 세션 연산으로 처리한다. 부모 hypothesis가
이미 org-scoped이므로 링크는 hypothesis_id로 스코프된다.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hypothesis import Hypothesis, HypothesisEpicLink, HypothesisStoryLink
from app.repositories.base import BaseRepository


class HypothesisRepository(BaseRepository[Hypothesis]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(Hypothesis, session, org_id)

    async def list_filtered(
        self,
        *,
        project_id: uuid.UUID,
        status: str | None = None,
        owner_member_id: uuid.UUID | None = None,
        epic_id: uuid.UUID | None = None,
        story_id: uuid.UUID | None = None,
        limit: int = 100,
    ) -> list[Hypothesis]:
        q = select(Hypothesis).where(
            Hypothesis.org_id == self.org_id,
            Hypothesis.project_id == project_id,
        )
        if status is not None:
            q = q.where(Hypothesis.status == status)
        if owner_member_id is not None:
            q = q.where(Hypothesis.owner_member_id == owner_member_id)
        if epic_id is not None:
            q = q.where(
                Hypothesis.id.in_(
                    select(HypothesisEpicLink.hypothesis_id).where(
                        HypothesisEpicLink.epic_id == epic_id
                    )
                )
            )
        if story_id is not None:
            q = q.where(
                Hypothesis.id.in_(
                    select(HypothesisStoryLink.hypothesis_id).where(
                        HypothesisStoryLink.story_id == story_id
                    )
                )
            )
        q = q.order_by(Hypothesis.created_at.desc(), Hypothesis.id.desc()).limit(limit)
        return list((await self.session.execute(q)).scalars().all())

    # ── 링크 집계 ────────────────────────────────────────────────────────────
    async def get_epic_ids(self, hypothesis_id: uuid.UUID) -> list[uuid.UUID]:
        rows = (await self.session.execute(
            select(HypothesisEpicLink.epic_id).where(
                HypothesisEpicLink.hypothesis_id == hypothesis_id
            )
        )).scalars().all()
        return list(rows)

    async def get_story_ids(self, hypothesis_id: uuid.UUID) -> list[uuid.UUID]:
        rows = (await self.session.execute(
            select(HypothesisStoryLink.story_id).where(
                HypothesisStoryLink.hypothesis_id == hypothesis_id
            )
        )).scalars().all()
        return list(rows)

    async def get_epic_ids_map(
        self, hypothesis_ids: list[uuid.UUID]
    ) -> dict[uuid.UUID, list[uuid.UUID]]:
        result: dict[uuid.UUID, list[uuid.UUID]] = {hid: [] for hid in hypothesis_ids}
        if not hypothesis_ids:
            return result
        rows = (await self.session.execute(
            select(HypothesisEpicLink.hypothesis_id, HypothesisEpicLink.epic_id).where(
                HypothesisEpicLink.hypothesis_id.in_(hypothesis_ids)
            )
        )).all()
        for hid, eid in rows:
            result[hid].append(eid)
        return result

    async def get_story_ids_map(
        self, hypothesis_ids: list[uuid.UUID]
    ) -> dict[uuid.UUID, list[uuid.UUID]]:
        result: dict[uuid.UUID, list[uuid.UUID]] = {hid: [] for hid in hypothesis_ids}
        if not hypothesis_ids:
            return result
        rows = (await self.session.execute(
            select(HypothesisStoryLink.hypothesis_id, HypothesisStoryLink.story_id).where(
                HypothesisStoryLink.hypothesis_id.in_(hypothesis_ids)
            )
        )).all()
        for hid, sid in rows:
            result[hid].append(sid)
        return result

    # ── 링크 추가/제거 (멱등: 기존 (hypothesis, target) 쌍은 건너뜀) ──────────────
    async def add_epic_links(
        self, hypothesis_id: uuid.UUID, epic_ids: list[uuid.UUID], link_type: str = "primary"
    ) -> None:
        if not epic_ids:
            return
        existing = set(await self.get_epic_ids(hypothesis_id))
        for eid in epic_ids:
            if eid in existing:
                continue
            self.session.add(
                HypothesisEpicLink(hypothesis_id=hypothesis_id, epic_id=eid, link_type=link_type)
            )
        await self.session.flush()

    async def add_story_links(
        self, hypothesis_id: uuid.UUID, story_ids: list[uuid.UUID], link_type: str = "supports"
    ) -> None:
        if not story_ids:
            return
        existing = set(await self.get_story_ids(hypothesis_id))
        for sid in story_ids:
            if sid in existing:
                continue
            self.session.add(
                HypothesisStoryLink(hypothesis_id=hypothesis_id, story_id=sid, link_type=link_type)
            )
        await self.session.flush()

    async def remove_epic_links(
        self, hypothesis_id: uuid.UUID, epic_ids: list[uuid.UUID]
    ) -> None:
        if not epic_ids:
            return
        links = (await self.session.execute(
            select(HypothesisEpicLink).where(
                HypothesisEpicLink.hypothesis_id == hypothesis_id,
                HypothesisEpicLink.epic_id.in_(epic_ids),
            )
        )).scalars().all()
        for link in links:
            await self.session.delete(link)
        await self.session.flush()

    async def remove_story_links(
        self, hypothesis_id: uuid.UUID, story_ids: list[uuid.UUID]
    ) -> None:
        if not story_ids:
            return
        links = (await self.session.execute(
            select(HypothesisStoryLink).where(
                HypothesisStoryLink.hypothesis_id == hypothesis_id,
                HypothesisStoryLink.story_id.in_(story_ids),
            )
        )).scalars().all()
        for link in links:
            await self.session.delete(link)
        await self.session.flush()
