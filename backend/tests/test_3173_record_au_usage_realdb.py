"""story #3173(결제②-B) — record_au_usage() 실PG 검증. 신규 행 생성 + 기존 행 원자적
증분(같은 달 재호출 시 새 행이 아니라 current_value가 누적)을 확認한다."""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")


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


@pytest.mark.anyio
async def test_record_au_usage_creates_then_increments_same_period_row():
    # au_metering.py가 `from app.core.database import async_session_factory`로 이름을
    # 자기 모듈 네임스페이스에 바인딩해 두므로, 패치는 반드시 au_metering 모듈 자체의
    # 속성을 갈아끼워야 한다(app.core.database 쪽을 바꿔봐야 이미 바인딩된 이름엔 무영향).
    import app.services.au_metering as au_metering_module
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    original_factory = au_metering_module.async_session_factory
    au_metering_module.async_session_factory = Session
    try:
        from app.services.au_metering import record_au_usage

        async with Session() as session:
            org_id = await _seed_org(session)
        try:
            await record_au_usage(org_id, 5)
            await record_au_usage(org_id, 5)

            async with Session() as session:
                rows = (
                    await session.execute(
                        text(
                            "SELECT meter_type, current_value FROM usage_meters "
                            "WHERE org_id = :org_id"
                        ),
                        {"org_id": org_id},
                    )
                ).all()
                assert len(rows) == 1, f"기간당 정확히 1행이어야 함 — {rows}"
                assert rows[0][0] == "automation_units"
                assert rows[0][1] == 10, "두 번 호출(5+5) 누적 안 됨 — 원자적 증분 실패"
        finally:
            async with Session() as session:
                await session.execute(text("DELETE FROM usage_meters WHERE org_id = :org_id"), {"org_id": org_id})
                await session.execute(text("DELETE FROM organizations WHERE id = :org_id"), {"org_id": org_id})
                await session.commit()
    finally:
        au_metering_module.async_session_factory = original_factory
        await engine.dispose()


@pytest.mark.anyio
async def test_record_au_usage_zero_delta_is_noop():
    import app.services.au_metering as au_metering_module
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    original_factory = au_metering_module.async_session_factory
    au_metering_module.async_session_factory = Session
    try:
        from app.services.au_metering import record_au_usage

        async with Session() as session:
            org_id = await _seed_org(session)
        try:
            await record_au_usage(org_id, 0)
            async with Session() as session:
                count = (
                    await session.execute(
                        text("SELECT count(*) FROM usage_meters WHERE org_id = :org_id"),
                        {"org_id": org_id},
                    )
                ).scalar_one()
                assert count == 0
        finally:
            async with Session() as session:
                await session.execute(text("DELETE FROM organizations WHERE id = :org_id"), {"org_id": org_id})
                await session.commit()
    finally:
        au_metering_module.async_session_factory = original_factory
        await engine.dispose()
