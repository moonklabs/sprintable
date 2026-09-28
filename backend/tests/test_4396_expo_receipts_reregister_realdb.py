"""story #4396 (PO 17:40Z ①) — a late DeviceNotRegistered receipt must not switch off a device registered again after the push.

A receipt can arrive up to 24 h after sending. In between the app may register the same token again: the repository upsert
sets is_active=True and last_seen_at=now() on the same row. Deactivation therefore requires last_seen_at <= sent_at. Real PG
and the real PushDeviceRepository.upsert (so the test also proves that a re-registration moves last_seen_at).
"""
from __future__ import annotations

import asyncio
import contextlib
import os
import uuid

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models.push_device import PushDevice
from app.repositories.push_device import PushDeviceRepository
from ee.services import expo_receipts as er

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")
pytestmark = [pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip"), pytest.mark.anyio]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@contextlib.asynccontextmanager
async def _env(monkeypatch):
    from app.core import database

    eng = create_async_engine(_ASYNC)
    Session = async_sessionmaker(eng, expire_on_commit=False, class_=AsyncSession)
    monkeypatch.setattr(database, "async_session_factory", Session)
    org = uuid.uuid4()
    async with Session() as s:
        await s.execute(text(f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{org}','O','o-{org.hex[:12]}','free')"))
        await s.commit()
    try:
        yield Session, org
    finally:
        async with Session() as s:
            await s.execute(text(f"DELETE FROM push_devices WHERE org_id = '{org}'"))
            await s.execute(text(f"DELETE FROM organizations WHERE id = '{org}'"))
            await s.commit()
        await eng.dispose()


async def _register(Session, org, token: str) -> PushDevice:
    async with Session() as s:
        device = await PushDeviceRepository(s, org).upsert(
            member_id=uuid.UUID(int=1), expo_push_token=token, apns_device_token=None, platform="android",
            device_id=None, app_version="1.0",
        )
        await s.commit()
        return device


async def _row(Session, device_id) -> PushDevice:
    async with Session() as s:
        return (await s.execute(select(PushDevice).where(PushDevice.id == device_id))).scalar_one()


async def test_device_not_registered_again_is_switched_off(monkeypatch):
    async with _env(monkeypatch) as (Session, org):
        device = await _register(Session, org, f"ExponentPushToken[a-{uuid.uuid4().hex[:8]}]")
        sent_at = device.last_seen_at.timestamp() + 1  # the push went out after the registration
        assert await er._deactivate_devices(org, [(device.id, sent_at)]) == 1  # rows actually switched off
        assert (await _row(Session, device.id)).is_active is False


async def test_device_registered_again_after_the_push_stays_on(monkeypatch):
    async with _env(monkeypatch) as (Session, org):
        token = f"ExponentPushToken[b-{uuid.uuid4().hex[:8]}]"
        device = await _register(Session, org, token)
        sent_at = device.last_seen_at.timestamp() + 0.001  # the push
        await asyncio.sleep(0.05)
        again = await _register(Session, org, token)  # the app registers the same token again
        assert again.id == device.id
        assert again.last_seen_at.timestamp() > sent_at  # the upsert moved last_seen_at
        assert await er._deactivate_devices(org, [(device.id, sent_at)]) == 0  # the late receipt says DeviceNotRegistered
        assert (await _row(Session, device.id)).is_active is True
