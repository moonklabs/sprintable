"""E1-S2: Hypothesis repository — CRUD(BaseRepository) + epic/story 링크 테이블.

링크 테이블(hypothesis_epic_links·hypothesis_story_links)은 org_id가 없어
BaseRepository의 tenant 주입을 쓰지 않고 plain 세션 연산으로 처리한다. 부모 hypothesis가
이미 org-scoped이므로 링크는 hypothesis_id로 스코프된다.
"""
from __future__ import annotations

import uuid

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hypothesis import (
    Hypothesis,
    HypothesisEpicLink,
    HypothesisSprintLink,
    HypothesisStoryLink,
)
from app.models.pm import Story
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
        sprint_id: uuid.UUID | None = None,
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
        if sprint_id is not None:
            q = q.where(
                Hypothesis.id.in_(
                    select(HypothesisSprintLink.hypothesis_id).where(
                        HypothesisSprintLink.sprint_id == sprint_id
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

    async def get_sprint_id(self, hypothesis_id: uuid.UUID) -> uuid.UUID | None:
        """N:1 — 가설당 sprint 링크는 최대 1개(uq_hypothesis_sprint_links_hypothesis)."""
        return await self.session.scalar(
            select(HypothesisSprintLink.sprint_id).where(
                HypothesisSprintLink.hypothesis_id == hypothesis_id
            )
        )

    async def get_sprint_ids_map(
        self, hypothesis_ids: list[uuid.UUID]
    ) -> dict[uuid.UUID, uuid.UUID | None]:
        result: dict[uuid.UUID, uuid.UUID | None] = {hid: None for hid in hypothesis_ids}
        if not hypothesis_ids:
            return result
        rows = (await self.session.execute(
            select(HypothesisSprintLink.hypothesis_id, HypothesisSprintLink.sprint_id).where(
                HypothesisSprintLink.hypothesis_id.in_(hypothesis_ids)
            )
        )).all()
        for hid, sid in rows:
            result[hid] = sid
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

    async def set_sprint_link(
        self, hypothesis_id: uuid.UUID, sprint_id: uuid.UUID, link_type: str = "declared"
    ) -> None:
        """N:1 upsert — 같은 sprint면 no-op, 다른 sprint면 기존 링크 delete 후 재생성
        (uq_hypothesis_sprint_links_hypothesis 단독 unique라 pair-idempotent add로는 불가:
        재배정은 명시적 교체여야 함)."""
        existing = (await self.session.execute(
            select(HypothesisSprintLink).where(
                HypothesisSprintLink.hypothesis_id == hypothesis_id
            )
        )).scalar_one_or_none()
        if existing is not None:
            if existing.sprint_id == sprint_id:
                return
            await self.session.delete(existing)
            await self.session.flush()
        self.session.add(
            HypothesisSprintLink(
                hypothesis_id=hypothesis_id, sprint_id=sprint_id, link_type=link_type
            )
        )
        await self.session.flush()

    async def remove_sprint_link(self, hypothesis_id: uuid.UUID) -> None:
        existing = (await self.session.execute(
            select(HypothesisSprintLink).where(
                HypothesisSprintLink.hypothesis_id == hypothesis_id
            )
        )).scalar_one_or_none()
        if existing is not None:
            await self.session.delete(existing)
            await self.session.flush()

    # ── dispatch anchor 해소 (S6 §5.2) ──────────────────────────────────────────
    async def _primary_via_epic(self, epic_id: uuid.UUID) -> Hypothesis | None:
        """epic의 link_type='primary' 가설. 여럿이면 active 우선·최신 created_at 순."""
        row = await self.session.execute(
            select(Hypothesis)
            .join(HypothesisEpicLink, HypothesisEpicLink.hypothesis_id == Hypothesis.id)
            .where(
                Hypothesis.org_id == self.org_id,
                HypothesisEpicLink.epic_id == epic_id,
                HypothesisEpicLink.link_type == "primary",
            )
            .order_by(desc(Hypothesis.status == "active"), Hypothesis.created_at.desc())
            .limit(1)
        )
        return row.scalar_one_or_none()

    async def _primary_via_story(self, story_id: uuid.UUID) -> Hypothesis | None:
        row = await self.session.execute(
            select(Hypothesis)
            .join(HypothesisStoryLink, HypothesisStoryLink.hypothesis_id == Hypothesis.id)
            .where(
                Hypothesis.org_id == self.org_id,
                HypothesisStoryLink.story_id == story_id,
                HypothesisStoryLink.link_type == "primary",
            )
            .order_by(desc(Hypothesis.status == "active"), Hypothesis.created_at.desc())
            .limit(1)
        )
        return row.scalar_one_or_none()

    async def resolve_primary_anchor(
        self, entity_type: str, entity_id: uuid.UUID
    ) -> Hypothesis | None:
        """dispatch 대상의 대표 가설(§5.2).

        story: story link primary 우선 → 없으면 story의 epic primary로 fallback.
        epic: epic link primary. doc 등 그 외: None.
        """
        if entity_type == "story":
            hyp = await self._primary_via_story(entity_id)
            if hyp is not None:
                return hyp
            epic_id = await self.session.scalar(
                select(Story.epic_id).where(
                    Story.id == entity_id, Story.org_id == self.org_id
                )
            )
            if epic_id is not None:
                return await self._primary_via_epic(epic_id)
            return None
        if entity_type == "epic":
            return await self._primary_via_epic(entity_id)
        return None
