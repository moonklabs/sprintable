import uuid
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import OrgMember


class OrgMemberRepository:
    """org_id 기반 스코핑 — OrgScopedMixin 미사용이므로 BaseRepository 미상속."""

    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        self.session = session
        self.org_id = org_id

    def _base_filter(self):
        return (OrgMember.org_id == self.org_id, OrgMember.deleted_at.is_(None))

    async def get(self, id: uuid.UUID) -> OrgMember | None:
        result = await self.session.execute(
            select(OrgMember).where(*self._base_filter(), OrgMember.id == id)
        )
        return result.scalar_one_or_none()

    async def get_by_user(self, user_id: uuid.UUID) -> OrgMember | None:
        result = await self.session.execute(
            select(OrgMember).where(*self._base_filter(), OrgMember.user_id == user_id)
        )
        return result.scalar_one_or_none()

    async def list(self, **filters: Any) -> list[OrgMember]:
        q = select(OrgMember).where(*self._base_filter())
        for attr, val in filters.items():
            q = q.where(getattr(OrgMember, attr) == val)
        result = await self.session.execute(q)
        return list(result.scalars().all())

    async def create(self, **data: Any) -> OrgMember:
        obj = OrgMember(org_id=self.org_id, **data)
        self.session.add(obj)
        await self.session.flush()
        await self.session.refresh(obj)
        return obj

    async def update(self, id: uuid.UUID, **data: Any) -> OrgMember | None:
        await self.session.execute(
            update(OrgMember)
            .where(OrgMember.org_id == self.org_id, OrgMember.id == id)
            .values(**data)
        )
        if "role" in data:
            # story #3510 — 0075 ID 보존 불변식(members.id == org_member.id, 휴먼)으로
            # 앵커(members.org_role)를 같은 트랜잭션에 동기화한다. members 행이 아직 없는
            # grant-only 휴먼(members-sync 갭)이면 0행 UPDATE로 조용히 no-op(anchor 리졸버가
            # org_members 폴백으로 흡수, member_resolver.py 참고) — 별도 존재 확인 불필요.
            from app.models.member import Member
            await self.session.execute(
                update(Member)
                .where(Member.id == id, Member.type == "human")
                .values(org_role=data["role"])
            )
        return await self.get(id)

    async def soft_delete(self, id: uuid.UUID) -> bool:
        """deleted_at 설정으로 soft delete."""
        from datetime import datetime, timezone
        member = await self.get(id)
        if member is None:
            return False
        await self.session.execute(
            update(OrgMember)
            .where(OrgMember.org_id == self.org_id, OrgMember.id == id)
            .values(deleted_at=datetime.now(timezone.utc))
        )
        return True
