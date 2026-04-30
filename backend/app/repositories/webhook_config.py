from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.webhook_config import WebhookConfig


class WebhookConfigRepository:
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        self.session = session
        self.org_id = org_id

    async def list(self, project_id: uuid.UUID | None = None) -> list[WebhookConfig]:
        q = select(WebhookConfig).where(WebhookConfig.org_id == self.org_id)
        if project_id is not None:
            q = q.where(WebhookConfig.project_id == project_id)
        q = q.order_by(WebhookConfig.created_at.desc())
        result = await self.session.execute(q)
        return list(result.scalars().all())

    async def get(self, id: uuid.UUID) -> WebhookConfig | None:
        result = await self.session.execute(
            select(WebhookConfig).where(WebhookConfig.id == id, WebhookConfig.org_id == self.org_id)
        )
        return result.scalar_one_or_none()

    async def get_by_project(self, project_id: uuid.UUID) -> list[WebhookConfig]:
        result = await self.session.execute(
            select(WebhookConfig).where(
                WebhookConfig.project_id == project_id,
                WebhookConfig.is_active.is_(True),
            )
        )
        return list(result.scalars().all())

    async def upsert(
        self,
        member_id: uuid.UUID,
        url: str,
        project_id: uuid.UUID | None = None,
        events: list[str] | None = None,
        is_active: bool = True,
    ) -> WebhookConfig:
        existing = await self.session.execute(
            select(WebhookConfig).where(
                WebhookConfig.org_id == self.org_id,
                WebhookConfig.url == url,
            )
        )
        config = existing.scalar_one_or_none()

        if config is None:
            config = WebhookConfig(
                org_id=self.org_id,
                member_id=member_id,
                url=url,
                project_id=project_id,
                events=events or [],
                is_active=is_active,
            )
            self.session.add(config)
        else:
            if project_id is not None:
                config.project_id = project_id
            if events is not None:
                config.events = events
            config.is_active = is_active

        await self.session.flush()
        await self.session.refresh(config)
        return config

    async def delete(self, id: uuid.UUID) -> bool:
        config = await self.get(id)
        if config is None:
            return False
        await self.session.delete(config)
        return True
