from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project_api_key import ProjectApiKey


def _generate_key() -> tuple[str, str, str]:
    raw = secrets.token_hex(32)
    prefix = f"pk_live_{raw[:8]}"
    plaintext = f"pk_live_{raw}"
    key_hash = hashlib.sha256(plaintext.encode()).hexdigest()
    return plaintext, prefix, key_hash


class ProjectApiKeyRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(
        self,
        project_id: uuid.UUID,
        created_by: uuid.UUID | None,
        name: str,
        scope: list[str] | None,
        plan_feature_ids: list[uuid.UUID] | None,
    ) -> tuple[ProjectApiKey, str]:
        plaintext, prefix, key_hash = _generate_key()
        key = ProjectApiKey(
            project_id=project_id,
            created_by=created_by,
            name=name,
            key_prefix=prefix,
            key_hash=key_hash,
            scope=scope,
            plan_feature_ids=plan_feature_ids,
        )
        self.session.add(key)
        await self.session.flush()
        return key, plaintext

    async def list_by_project(self, project_id: uuid.UUID) -> list[ProjectApiKey]:
        result = await self.session.execute(
            select(ProjectApiKey)
            .where(ProjectApiKey.project_id == project_id)
            .order_by(ProjectApiKey.created_at.desc())
        )
        return list(result.scalars().all())

    async def get(self, key_id: uuid.UUID) -> ProjectApiKey | None:
        result = await self.session.execute(
            select(ProjectApiKey).where(ProjectApiKey.id == key_id)
        )
        return result.scalar_one_or_none()

    async def revoke(self, key: ProjectApiKey) -> ProjectApiKey:
        key.revoked_at = datetime.now(timezone.utc)
        await self.session.flush()
        return key
