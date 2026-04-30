from __future__ import annotations

import uuid

from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.organization import Organization


class OrganizationRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get(self, org_id: uuid.UUID) -> Organization | None:
        result = await self.session.execute(
            select(Organization).where(Organization.id == org_id)
        )
        return result.scalar_one_or_none()

    async def slug_exists(self, slug: str) -> bool:
        result = await self.session.execute(
            select(Organization.id).where(Organization.slug == slug)
        )
        return result.scalar_one_or_none() is not None

    async def create(self, name: str, slug: str, owner_member_id: uuid.UUID) -> Organization | None:
        if await self.slug_exists(slug):
            return None
        org = Organization(name=name, slug=slug)
        self.session.add(org)
        await self.session.flush()
        await self.session.refresh(org)
        await self.session.execute(
            text(
                "INSERT INTO org_members (org_id, user_id, role)"
                " SELECT :org_id, user_id, 'owner' FROM team_members WHERE id = :member_id"
                " ON CONFLICT (org_id, user_id) DO NOTHING"
            ),
            {"org_id": str(org.id), "member_id": str(owner_member_id)},
        )
        return org

    async def delete(self, org_id: uuid.UUID, requester_member_id: uuid.UUID) -> dict:
        org = await self.get(org_id)
        if org is None:
            return {"ok": False, "reason": "not_found"}

        owner_check = await self.session.execute(
            text(
                "SELECT 1 FROM org_members om"
                " JOIN team_members tm ON tm.user_id = om.user_id"
                " WHERE om.org_id = :org_id AND tm.id = :member_id AND om.role = 'owner'"
            ),
            {"org_id": str(org_id), "member_id": str(requester_member_id)},
        )
        if owner_check.first() is None:
            return {"ok": False, "reason": "forbidden"}

        sub_check = await self.session.execute(
            text(
                "SELECT 1 FROM org_subscriptions"
                " WHERE org_id = :org_id AND status = 'active' LIMIT 1"
            ),
            {"org_id": str(org_id)},
        )
        if sub_check.first() is not None:
            return {"ok": False, "reason": "active_subscription"}

        await self.session.delete(org)
        return {"ok": True}
