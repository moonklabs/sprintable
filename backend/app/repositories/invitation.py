from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.invitation import Invitation
from app.repositories.base import BaseRepository


class InvitationRepository:
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        self.session = session
        self.org_id = org_id

    async def list(self, project_id: uuid.UUID | None = None) -> list[Invitation]:
        q = select(Invitation).where(Invitation.org_id == self.org_id)
        if project_id is not None:
            q = q.where(Invitation.project_id == project_id)
        q = q.order_by(Invitation.created_at.desc())
        result = await self.session.execute(q)
        return list(result.scalars().all())

    async def get(self, id: uuid.UUID) -> Invitation | None:
        result = await self.session.execute(
            select(Invitation).where(Invitation.id == id, Invitation.org_id == self.org_id)
        )
        return result.scalar_one_or_none()

    async def get_by_token(self, token: str) -> Invitation | None:
        result = await self.session.execute(
            select(Invitation).where(Invitation.token == token)
        )
        return result.scalar_one_or_none()

    async def create(
        self,
        email: str,
        role: str,
        invited_by: uuid.UUID,
        project_id: uuid.UUID | None = None,
    ) -> Invitation:
        inv = Invitation(
            org_id=self.org_id,
            project_id=project_id,
            email=email,
            role=role,
            invited_by=invited_by,
            expires_at=datetime.now(timezone.utc) + timedelta(days=7),
        )
        self.session.add(inv)
        await self.session.flush()
        await self.session.refresh(inv)
        return inv

    async def revoke(self, id: uuid.UUID) -> Invitation | None:
        inv = await self.get(id)
        if inv is None:
            return None
        inv.status = "revoked"
        await self.session.flush()
        await self.session.refresh(inv)
        return inv

    async def resend(self, id: uuid.UUID) -> Invitation | None:
        inv = await self.get(id)
        if inv is None:
            return None
        if inv.status == "revoked":
            return None
        inv.token = secrets.token_hex(32)
        inv.expires_at = datetime.now(timezone.utc) + timedelta(days=7)
        inv.status = "pending"
        await self.session.flush()
        await self.session.refresh(inv)
        return inv

    async def accept(self, token: str) -> Invitation | None:
        inv = await self.get_by_token(token)
        if inv is None:
            return None
        if inv.status != "pending":
            return None
        if inv.expires_at < datetime.now(timezone.utc):
            return None
        inv.status = "accepted"
        inv.accepted_at = datetime.now(timezone.utc)
        await self.session.flush()
        await self.session.refresh(inv)
        return inv
