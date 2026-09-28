"""story #4239 — 플랫폼 프리셋 발행 stage의 허용 채널 선언 전수 가드(migrated DB · non-destructive). 시드 마이그레이션(0402)이
실은 `capability.channels`를 실제 행에서 본다 — destructive 파일(create_all · 시드 없음)과 분리."""
from __future__ import annotations

import os

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"



async def test_every_platform_channel_connection_stage_declares_its_channels():
    """migrated DB의 플랫폼 프리셋(org_id NULL · 시드 마이그레이션이 만든 key) 전부: target="channel_connection" stage는
    `capability.channels`를 **반드시** 선언한다 — 선언 빠진 새 프리셋은 여기서 RED(적용 창이 다시 전체 채널을 보여 주는
    클래스 재발 방지). 조직 정의는 선택(없으면 예전대로 전체 허용). 공유 DB엔 다른 테스트가 넣은 org_id NULL 정의가 섞일 수
    있어, 전수 대상은 `preset.` 접두의 플랫폼 key로 좁힌다."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            rows = (await conn.execute(text(
                "SELECT key, stage_metadata, payload_schema FROM event_definitions WHERE org_id IS NULL AND key LIKE 'preset.%'"
            ))).all()
    finally:
        await engine.dispose()
    from app.services.event_definition_registry import validate_stage_metadata

    for key, meta, payload_schema in rows:
        validate_stage_metadata(payload_schema, meta or {})  # 선언이 모양 검증도 통과(닫힌 채널 어휘 등)
    rows = [(key, meta) for key, meta, _schema in rows]
    missing = sorted(
        f"{key}:{stage}"
        for key, meta in rows
        for stage, stage_meta in (meta or {}).items()
        if ((stage_meta or {}).get("capability") or {}).get("target") == "channel_connection"
        and not ((stage_meta or {}).get("capability") or {}).get("channels")
    )
    assert missing == [], f"허용 채널(capability.channels) 선언이 없는 플랫폼 발행 stage: {missing}"
    declared = {key for key, meta in rows for stage_meta in (meta or {}).values()
                if ((stage_meta or {}).get("capability") or {}).get("channels")}
    assert {"preset.marketing.newsletter", "preset.marketing.social_text_post",
            "preset.marketing.social_card_news", "preset.marketing.video_production"} <= declared
