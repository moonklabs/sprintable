"""story #4255 AC3 — 플랫폼 정의 전수: 마지막 단계가 서버 stage(채널 연결 게시)인 정의와 그 촉발 게이트.

마지막 서버 stage 이벤트의 수신자는 «직전 stage가 연 이 레시피 게이트를 실제로 승인한 사람»이다(event_routing_resolver
`_last_server_stage_recipients`). 그러려면 직전 stage가 게이트를 선언해야 한다 — 선언이 없으면 받을 사람을 모른다(0 + 경고).
이 표가 그 전제를 고정한다. 정의가 새로 생기거나 순서가 바뀌면 RED가 나서 사람이 한 번 본다.

실 PG(alembic heads) 위 읽기 전용 — 시드된 플랫폼 정의(org_id NULL) 그대로.
"""
from __future__ import annotations

import os

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]

# 정의 → (마지막 서버 stage, 직전 stage, 직전 stage 게이트 타입). 게이트 타입 None이면 받을 사람을 모르는 정의다.
_EXPECTED: dict[str, tuple[str, str, str | None]] = {
    "preset.marketing.social_card_news": ("published", "pending_approval", "external_publish"),
    "preset.marketing.social_text_post": ("published", "pending_approval", "external_publish"),
    "preset.marketing.video_production": ("published", "pending_approval", "external_publish"),
}


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _census() -> dict[str, tuple[str, str, str | None]]:
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.models.event_definition import EventDefinition
    from app.routers.events import _previous_recipe_stage

    engine = create_async_engine(_async_url())
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as s:
            definitions = (await s.execute(
                select(EventDefinition).where(EventDefinition.org_id.is_(None), EventDefinition.enabled.is_(True))
            )).scalars().all()
    finally:
        await engine.dispose()
    table: dict[str, tuple[str, str, str | None]] = {}
    for d in definitions:
        enum = (((d.payload_schema or {}).get("properties") or {}).get("stage") or {}).get("enum") or []
        if not enum:
            continue
        last = enum[-1]
        last_meta = (d.stage_metadata or {}).get(last) or {}
        if (last_meta.get("capability") or {}).get("target") != "channel_connection":
            continue
        previous = _previous_recipe_stage(d, last)
        gate = ((d.stage_metadata or {}).get(previous) or {}).get("gate") if previous else None
        table[d.key] = (last, previous, gate["type"] if gate else None)
    return table


async def test_every_platform_recipe_ending_in_a_server_stage_has_a_trigger_gate_on_the_previous_stage():
    table = await _census()
    assert table == _EXPECTED, "\n".join(f"{k}: {v!r}" for k, v in sorted(table.items()))
    assert all(gate_type is not None for _last, _previous, gate_type in table.values())
