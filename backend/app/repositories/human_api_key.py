from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.human_api_key import HumanApiKey

# story #1940 — hu_live_ 접두사: sk_live_(에이전트)과 명확히 구분(PO AC2·시크릿 스캐너
# 식별 가능해야 함). 해싱은 app.core.security.hash_token과 동일 알고리즘(sha256) 재사용
# — 여기서는 hashlib 직접(순환import 회피, 알고리즘만 일치시키면 됨).


def _generate_key() -> tuple[str, str, str]:
    raw = secrets.token_hex(32)
    prefix = f"hu_live_{raw[:8]}"
    plaintext = f"hu_live_{raw}"
    key_hash = hashlib.sha256(plaintext.encode()).hexdigest()
    return plaintext, prefix, key_hash


class HumanApiKeyRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list_by_member(self, member_id: uuid.UUID) -> list[HumanApiKey]:
        result = await self.session.execute(
            select(HumanApiKey)
            .where(HumanApiKey.member_id == member_id)
            .order_by(HumanApiKey.created_at.desc())
        )
        return list(result.scalars().all())

    async def get(self, key_id: uuid.UUID) -> HumanApiKey | None:
        result = await self.session.execute(
            select(HumanApiKey).where(HumanApiKey.id == key_id)
        )
        return result.scalar_one_or_none()

    async def create(
        self,
        member_id: uuid.UUID,
        name: str | None = None,
        *,
        expires_at: datetime | None,
    ) -> tuple[HumanApiKey, str]:
        """story #2839(#2838 사람 키 판, PO 확定 패턴 그대로 이식) — 침묵 90일 각인 제거.
        기본값 없는 필수 kwarg: 호출자가 무만료(None)를 명시적으로 골라야만 무만료가 된다 —
        "호출자가 안 골랐다"와 "명시적으로 무만료를 골랐다"가 둘 다 None으로 뭉개지던 근본원인."""
        plaintext, prefix, key_hash = _generate_key()
        key = HumanApiKey(
            member_id=member_id,
            name=name,
            key_prefix=prefix,
            key_hash=key_hash,
            expires_at=expires_at,
        )
        self.session.add(key)
        await self.session.flush()
        await self.session.refresh(key)
        return key, plaintext

    async def revoke(self, key_id: uuid.UUID) -> HumanApiKey | None:
        key = await self.get(key_id)
        if key is None:
            return None
        key.revoked_at = datetime.now(timezone.utc)
        await self.session.flush()
        await self.session.refresh(key)
        return key
