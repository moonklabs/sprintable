from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.org_invite import OrgInvite
from app.models.project import OrgMember

_INVITE_EXPIRE_DAYS = 7


class OrgInviteRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def is_already_member(self, org_id: uuid.UUID, email: str) -> bool:
        """해당 org에 이미 가입된 email 여부 확인."""
        from app.models.user import User
        result = await self.session.execute(
            select(OrgMember.id)
            .join(User, User.id == OrgMember.user_id)
            .where(
                OrgMember.org_id == org_id,
                User.email == email.lower().strip(),
                OrgMember.deleted_at.is_(None),
            )
            .limit(1)
        )
        return result.scalar_one_or_none() is not None

    async def has_pending_invite(self, org_id: uuid.UUID, email: str) -> bool:
        """같은 org+email의 pending 초대가 이미 존재하는지 확인."""
        result = await self.session.execute(
            select(OrgInvite.id).where(
                OrgInvite.organization_id == org_id,
                OrgInvite.email == email.lower().strip(),
                OrgInvite.status == "pending",
            ).limit(1)
        )
        return result.scalar_one_or_none() is not None

    async def create(
        self,
        org_id: uuid.UUID,
        email: str,
        role: str,
        created_by: uuid.UUID,
    ) -> OrgInvite | None:
        """초대 생성. pending 중복(org+email) 시 None 반환 (revoke 후 재초대 허용)."""
        if await self.has_pending_invite(org_id=org_id, email=email):
            return None
        now = datetime.now(timezone.utc)
        invite = OrgInvite(
            organization_id=org_id,
            email=email.lower().strip(),
            role=role,
            expires_at=now + timedelta(days=_INVITE_EXPIRE_DAYS),
            created_by=created_by,
        )
        self.session.add(invite)
        try:
            await self.session.flush()
            await self.session.refresh(invite)
        except IntegrityError:
            await self.session.rollback()
            return None
        return invite

    async def list_pending(self, org_id: uuid.UUID) -> list[OrgInvite]:
        """pending + 미만료 초대 목록 (최신순)."""
        now = datetime.now(timezone.utc)
        result = await self.session.execute(
            select(OrgInvite)
            .where(
                OrgInvite.organization_id == org_id,
                OrgInvite.status == "pending",
                OrgInvite.expires_at > now,
            )
            .order_by(OrgInvite.created_at.desc())
        )
        return list(result.scalars().all())

    async def get_by_token(self, token: str) -> OrgInvite | None:
        result = await self.session.execute(
            select(OrgInvite).where(OrgInvite.token == token)
        )
        return result.scalar_one_or_none()

    async def revoke(self, invite_id: uuid.UUID, org_id: uuid.UUID) -> OrgInvite | None:
        result = await self.session.execute(
            select(OrgInvite).where(
                OrgInvite.id == invite_id,
                OrgInvite.organization_id == org_id,
            )
        )
        invite = result.scalar_one_or_none()
        if invite is None:
            return None
        invite.status = "revoked"
        await self.session.flush()
        await self.session.refresh(invite)
        return invite
