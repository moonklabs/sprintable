from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy import update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.api_key import ApiKey


def _generate_key() -> tuple[str, str, str]:
    raw = secrets.token_hex(32)
    prefix = f"sk_live_{raw[:8]}"
    plaintext = f"sk_live_{raw}"
    key_hash = hashlib.sha256(plaintext.encode()).hexdigest()
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
            member_id=team_member_id,  # AC3-1 dual-write: agent member.id = team_member.id (1:1)
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

    async def rotate(
        self, api_key_id: uuid.UUID, scope: list[str] | None = None
    ) -> tuple[ApiKey, str] | None:
        """이전 키 revoke + 신규 발급. ``scope`` 미지정 시 이전 scope 그대로 승계(기존 동작 보존) —
        E-RECRUIT S3(story ff2996d0)가 역할변경 시 scope 를 새 role_template 파생값으로 교체하려고
        명시 override 를 추가했다(sentinel: None=승계 vs []=빈 scope 의도적 지정 구분).

        까심 QA HIGH(S3 RC) 방어: revoke를 compare-and-swap(``UPDATE ... WHERE revoked_at IS NULL``)
        으로 실행한다 — 동시 두 rotate 호출이 같은 키를 둘 다 "성공"으로 revoke+재발급해 active 키가
        2개 남는 레이스를 막는다. Postgres의 UPDATE 자체가 대상 행을 잠그므로 두번째 호출은 첫번째
        커밋 후 재평가돼 ``revoked_at IS NULL`` 이 거짓 → rowcount 0 → None(이미 다른 호출이 회전함).
        """
        old = await self.get(api_key_id)
        if old is None:
            return None

        result = await self.session.execute(
            sa_update(ApiKey)
            .where(ApiKey.id == api_key_id, ApiKey.revoked_at.is_(None))
            .values(revoked_at=datetime.now(timezone.utc))
        )
        if result.rowcount == 0:
            return None  # 레이스 패배 — 다른 호출이 이미 이 키를 회전시킴

        new_key, plaintext = await self.create(
            team_member_id=old.team_member_id,
            scope=scope if scope is not None else old.scope,
            expires_at=None,
        )
        return new_key, plaintext
