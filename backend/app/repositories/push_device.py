from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.push_device import PushDevice


class PushDeviceRepository:
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        self.session = session
        self.org_id = org_id

    async def list(self, member_id: uuid.UUID) -> list[PushDevice]:
        # IDOR: push_device 는 멤버-소유 리소스 — org_id 만이면 same-org 타 멤버 디바이스 토큰이 leak.
        # caller member-scope 강제(webhook_config 선례 동형).
        q = (
            select(PushDevice)
            .where(PushDevice.org_id == self.org_id, PushDevice.member_id == member_id)
            .order_by(PushDevice.last_seen_at.desc())
        )
        result = await self.session.execute(q)
        return list(result.scalars().all())

    async def get(self, id: uuid.UUID) -> PushDevice | None:
        """org-scope 조회 — **내부용**(upsert 직후 자기 행 재조회). 외부 노출 경로는 get_owned 사용."""
        result = await self.session.execute(
            select(PushDevice).where(PushDevice.id == id, PushDevice.org_id == self.org_id)
        )
        return result.scalar_one_or_none()

    async def get_owned(self, id: uuid.UUID, member_id: uuid.UUID) -> PushDevice | None:
        """소유 검증 조회 — id + org + **member**. same-org 타 멤버 device_id 를 알아도 None(IDOR 차단).
        폐기 등 외부 노출 경로의 표준 조회."""
        result = await self.session.execute(
            select(PushDevice).where(
                PushDevice.id == id,
                PushDevice.org_id == self.org_id,
                PushDevice.member_id == member_id,
            )
        )
        return result.scalar_one_or_none()

    async def upsert(
        self,
        member_id: uuid.UUID,
        expo_push_token: str,
        platform: str,
        device_id: str | None = None,
        app_version: str | None = None,
    ) -> PushDevice:
        """디바이스 등록 — expo_push_token UNIQUE 기준 upsert(재등록 자연 멱등).

        같은 디바이스가 재등록(앱 재설치·토큰 회전·기기 이관)하면 토큰 충돌 → 소유 org/멤버·플랫폼·메타·
        last_seen 갱신 + is_active 복구(True). crux §3: 발송기가 DeviceNotRegistered 수신 시 is_active=false
        로 내리므로 재등록이 활성 복구를 겸한다. org_id 도 set_ 에 포함 — 기기 이관 시 새 org 로 re-home
        (get() 재조회가 self.org_id 스코프라 조용한 500 방지)."""
        now = func.now()
        stmt = (
            pg_insert(PushDevice)
            .values(
                org_id=self.org_id,
                member_id=member_id,
                expo_push_token=expo_push_token,
                platform=platform,
                device_id=device_id,
                app_version=app_version,
                is_active=True,
            )
            .on_conflict_do_update(
                index_elements=["expo_push_token"],
                set_={
                    "org_id": self.org_id,
                    "member_id": member_id,
                    "platform": platform,
                    "device_id": device_id,
                    "app_version": app_version,
                    "is_active": True,
                    "last_seen_at": now,
                },
            )
            .returning(PushDevice.id)
        )
        result = await self.session.execute(stmt)
        device_pk = result.scalar_one()
        await self.session.flush()

        device = await self.get(device_pk)
        assert device is not None  # noqa: S101 — 방금 upsert한 행, 동일 org 스코프
        await self.session.refresh(device)
        return device

    async def delete(self, id: uuid.UUID, member_id: uuid.UUID) -> bool:
        # IDOR: 소유 검증(get_owned) — 타 멤버 device_id 로 폐기 차단.
        device = await self.get_owned(id, member_id)
        if device is None:
            return False
        await self.session.delete(device)
        return True
