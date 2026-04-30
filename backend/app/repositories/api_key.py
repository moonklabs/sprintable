from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.api_key import ApiKey


def _generate_key() -> tuple[str, str, str]:
    raw = secrets.token_hex(32)
    prefix = f"sk_live_{raw[:8]}"
    key_hash = hashlib.sha256(raw.encode()).hexdigest()
    plaintext = f"sk_live_{raw}"
    return plaintext, prefix, key_hash


class ApiKeyRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list_by_member(self, team_member_id: uuid.UUID) -> list[ApiKey]:
        result = await self.session.execute(
            select(ApiKey)
            .where(ApiKey.team_member_id == team_member_id)
            .order_by(ApiKey.created_at.desc())
        )
        return list(result.scalars().all())

    async def get(self, api_key_id: uuid.UUID) -> ApiKey | None:
        result = await self.session.execute(
            select(ApiKey).where(ApiKey.id == api_key_id)
        )
        return result.scalar_one_or_none()

    async def create(
        self,
        team_member_id: uuid.UUID,
        scope: list[str] | None = None,
        expires_at: datetime | None = None,
    ) -> tuple[ApiKey, str]:
        plaintext, prefix, key_hash = _generate_key()
        if expires_at is None:
            expires_at = datetime.now(timezone.utc) + timedelta(days=90)
        key = ApiKey(
            team_member_id=team_member_id,
            key_prefix=prefix,
            key_hash=key_hash,
            scope=scope,
            expires_at=expires_at,
        )
        self.session.add(key)
        await self.session.flush()
        await self.session.refresh(key)
        return key, plaintext

    async def revoke(self, api_key_id: uuid.UUID) -> ApiKey | None:
        key = await self.get(api_key_id)
        if key is None:
            return None
        key.revoked_at = datetime.now(timezone.utc)
        await self.session.flush()
        await self.session.refresh(key)
        return key

    async def rotate(self, api_key_id: uuid.UUID) -> tuple[ApiKey, str] | None:
        old = await self.get(api_key_id)
        if old is None:
            return None
        old.revoked_at = datetime.now(timezone.utc)
        new_key, plaintext = await self.create(
            team_member_id=old.team_member_id,
            scope=old.scope,
            expires_at=None,
        )
        return new_key, plaintext
