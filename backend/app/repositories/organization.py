from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.organization import Organization
from app.models.project import OrgMember, Project


@dataclass
class OrgImpact:
    project_count: int
    member_count: int
    has_active_subscription: bool


@dataclass
class OrganizationWithRole:
    id: uuid.UUID
    name: str
    slug: str
    plan: str
    role: str


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

    async def create(self, name: str, slug: str, owner_member_id: uuid.UUID | None) -> Organization | None:
        if await self.slug_exists(slug):
            return None
        org = Organization(name=name, slug=slug)
        self.session.add(org)
        await self.session.flush()
        await self.session.refresh(org)
        if owner_member_id is not None:
            await self.session.execute(
                text(
                    "INSERT INTO org_members (org_id, user_id, role)"
                    " SELECT :org_id, user_id, 'owner' FROM team_members WHERE id = :member_id"
                    " ON CONFLICT (org_id, user_id) DO NOTHING"
                ),
                {"org_id": str(org.id), "member_id": str(owner_member_id)},
            )
        # fresh org에 default implementation 역할 시드 — 없으면 merge gate가
        # "no implementation participation"으로 gate row 없이 영구 보류(교착).
        from app.services.participation_helpers import seed_default_participation_role

        await seed_default_participation_role(self.session, org.id)
        return org

    async def list_for_user(self, user_id: uuid.UUID) -> list[OrganizationWithRole]:
        """사용자가 org_members로 속한 Organization 목록 반환 (name ASC)."""
        result = await self.session.execute(
            select(
                Organization.id,
                Organization.name,
                Organization.slug,
                Organization.plan,
                OrgMember.role,
            )
            .join(OrgMember, OrgMember.org_id == Organization.id)
            .where(
                OrgMember.user_id == user_id,
                OrgMember.deleted_at.is_(None),
            )
            .order_by(Organization.name.asc())
        )
        return [
            OrganizationWithRole(id=row.id, name=row.name, slug=row.slug, plan=row.plan, role=row.role)
            for row in result.all()
        ]

    async def get_member_role(self, org_id: uuid.UUID, user_id: uuid.UUID) -> str | None:
        """org_members에서 user의 role 반환. 미소속 시 None."""
        result = await self.session.execute(
            select(OrgMember.role).where(
                OrgMember.org_id == org_id,
                OrgMember.user_id == user_id,
                OrgMember.deleted_at.is_(None),
            )
        )
        return result.scalar_one_or_none()

    async def update_name(self, org_id: uuid.UUID, name: str) -> Organization | None:
        """Organization 이름 수정 후 갱신된 객체 반환. 미존재 시 None."""
        org = await self.get(org_id)
        if org is None:
            return None
        org.name = name
        await self.session.flush()
        await self.session.refresh(org)
        return org

    async def get_impact(self, org_id: uuid.UUID) -> OrgImpact:
        """삭제 전 영향도 조회 — project 수, member 수, 활성 subscription 여부."""
        proj_count_row = await self.session.execute(
            select(func.count()).select_from(Project).where(
                Project.org_id == org_id,
                Project.deleted_at.is_(None),
            )
        )
        project_count = proj_count_row.scalar() or 0

        member_count_row = await self.session.execute(
            select(func.count()).select_from(OrgMember).where(
                OrgMember.org_id == org_id,
                OrgMember.deleted_at.is_(None),
            )
        )
        member_count = member_count_row.scalar() or 0

        sub_row = await self.session.execute(
            text(
                "SELECT 1 FROM org_subscriptions"
                " WHERE org_id = :org_id AND status = 'active' LIMIT 1"
            ),
            {"org_id": str(org_id)},
        )
        has_active_subscription = sub_row.first() is not None

        return OrgImpact(
            project_count=project_count,
            member_count=member_count,
            has_active_subscription=has_active_subscription,
        )

    async def delete_by_user(self, org_id: uuid.UUID, user_id: uuid.UUID, confirmation: str) -> dict:
        """owner 전용 삭제 — user_id로 직접 권한 검증 + confirmation 문자열 검사."""
        org = await self.get(org_id)
        if org is None:
            return {"ok": False, "reason": "not_found"}

        role = await self.get_member_role(org_id=org_id, user_id=user_id)
        if role != "owner":
            return {"ok": False, "reason": "forbidden"}

        if confirmation != org.name:
            return {"ok": False, "reason": "confirmation_mismatch"}

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
