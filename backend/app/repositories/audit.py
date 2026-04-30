from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import AuditLog


class AuditLogRepository:
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        self.session = session
        self.org_id = org_id

    async def list(self, limit: int = 50, cursor: str | None = None) -> list[AuditLog]:
        q = select(AuditLog).where(AuditLog.org_id == self.org_id)
        if cursor:
            from sqlalchemy import and_
            q = q.where(AuditLog.created_at < cursor)
        q = q.order_by(AuditLog.created_at.desc()).limit(min(limit, 200))
        result = await self.session.execute(q)
        return list(result.scalars().all())
