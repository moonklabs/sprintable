"""story #2473(결제②-A3) — 실PG 검증. usage_meters.meter_type CHECK를 v2.3 한도표
축(automation_units·realtime_connections·webhooks·automation_rules·event_replay_days)
으로 확장(migration 0287)했다. 이 스토리는 «미터가 값을 담을 그릇»만 넓히는 것이라
한도 집행 로직은 다루지 않는다 — 여기서 검증하는 것도 순수 DB CHECK 경계뿐이다.

커버:
  AC① — 신규 5종 전부 INSERT 성공(그릇이 실제로 넓어졌다).
  AC② — 기존 5종(ai_calls/storage_mb/members/agents/stt_minutes)도 여전히 INSERT
        성공(확장이 파괴가 아님 — 옛 값이 새 CHECK를 여전히 통과).
  AC③ — CHECK 자체가 살아있다는 음성대조(negative control): v2.3 한도표에도 없는
        임의 문자열은 여전히 거부된다 — CHECK가 통째로 사라진 게 아님을 실증.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

NEW_METER_TYPES = (
    "automation_units",
    "realtime_connections",
    "webhooks",
    "automation_rules",
    "event_replay_days",
)
OLD_METER_TYPES = ("ai_calls", "storage_mb", "members", "agents", "stt_minutes")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed_org(session):
    org_id = uuid.uuid4()
    await session.execute(
        text("INSERT INTO organizations (id, name, slug, plan) VALUES (:id, :name, :slug, 'free')"),
        {"id": org_id, "name": f"test-org-{org_id}", "slug": f"slug-{org_id}"},
    )
    await session.commit()
    return org_id


async def _insert_meter(session, *, org_id, meter_type):
    now = datetime.now(timezone.utc)
    await session.execute(
        text(
            "INSERT INTO usage_meters (id, org_id, meter_type, current_value, period_start) "
            "VALUES (:id, :org_id, :meter_type, 0, :period_start)"
        ),
        {"id": uuid.uuid4(), "org_id": org_id, "meter_type": meter_type, "period_start": now},
    )
    await session.commit()


@pytest.mark.anyio
async def test_new_v2_3_meter_types_accepted():
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            try:
                for meter_type in NEW_METER_TYPES:
                    await _insert_meter(session, org_id=org_id, meter_type=meter_type)

                rows = (
                    await session.execute(
                        text("SELECT meter_type FROM usage_meters WHERE org_id = :org_id"),
                        {"org_id": org_id},
                    )
                ).scalars().all()
                assert set(rows) == set(NEW_METER_TYPES)
            finally:
                await session.execute(text("DELETE FROM usage_meters WHERE org_id = :org_id"), {"org_id": org_id})
                await session.execute(text("DELETE FROM organizations WHERE id = :org_id"), {"org_id": org_id})
                await session.commit()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_existing_meter_types_still_accepted_after_check_expansion():
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            try:
                for meter_type in OLD_METER_TYPES:
                    await _insert_meter(session, org_id=org_id, meter_type=meter_type)

                rows = (
                    await session.execute(
                        text("SELECT meter_type FROM usage_meters WHERE org_id = :org_id"),
                        {"org_id": org_id},
                    )
                ).scalars().all()
                assert set(rows) == set(OLD_METER_TYPES)
            finally:
                await session.execute(text("DELETE FROM usage_meters WHERE org_id = :org_id"), {"org_id": org_id})
                await session.execute(text("DELETE FROM organizations WHERE id = :org_id"), {"org_id": org_id})
                await session.commit()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_unlisted_meter_type_still_rejected():
    """음성대조 — v2.3 한도표에도 없는 값은 CHECK가 여전히 막는다(확장 ≠ 무제한)."""
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            try:
                with pytest.raises(IntegrityError):
                    await _insert_meter(session, org_id=org_id, meter_type="not_a_real_meter_type")
            finally:
                await session.rollback()
                await session.execute(text("DELETE FROM usage_meters WHERE org_id = :org_id"), {"org_id": org_id})
                await session.execute(text("DELETE FROM organizations WHERE id = :org_id"), {"org_id": org_id})
                await session.commit()
    finally:
        await engine.dispose()
