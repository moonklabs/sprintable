"""story #4254 AC2 — 플랫폼 정의 전수: 게이트가 있는 stage마다 승인 알림 «다음 행동»이 무엇인가.

다음 stage를 **서버가** 내는 자리(채널 연결 발행 · 발송 게이트 · 서버 발행 stage)에는 발행 예시가 실리면 안 된다 — 그대로
따른 에이전트가 서버보다 먼저 다음 stage를 내면 흐름이 거짓 완료된다(4177 체인 실측 · 뉴스레터 발송 게이트).
판정 렌더러와 이 표가 같은 함수(`gate_verdict_next_action_kind`)를 읽는다. 정의나 게이트가 새로 생기면 이 표가 갱신을
요구한다 — 그 자리를 사람이 한 번 보고 «발행 예시가 맞는가»를 정한다.

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

# (정의, 게이트 stage, 게이트 타입) → 승인 알림 «다음 행동». None = 마지막 stage.
# 발행 예시가 실리는 자리(publish_example)는 다음 stage를 그 담당이 발행한다 — 작성 · 다듬기 · 구조 확인(사람이 예상 비용을
# 싣는 예산 게이트 발행) · 실제 생성(연산 커넥터 stage — 4110 PO 결정대로 에이전트가 낸다). 서버가 다음 stage를 내는 자리는
# 채널 연결 발행(channel_auto_publish)과 발송 게이트(server_sends)뿐이고, 둘 다 발행 예시를 싣지 않는다.
_EXPECTED: dict[tuple[str, str, str], str | None] = {
    ("preset.marketing.blog_article", "concept_confirmed", "concept_approval"): "publish_example",
    ("preset.marketing.newsletter", "review", "external_publish"): "channel_auto_publish",
    ("preset.marketing.newsletter", "send_requested", "newsletter_send"): "server_sends",
    ("preset.marketing.social_card_news", "budget_approved", "generation_budget"): "publish_example",
    ("preset.marketing.social_card_news", "concept_confirmed", "concept_approval"): "publish_example",
    ("preset.marketing.social_card_news", "pending_approval", "external_publish"): "channel_auto_publish",
    ("preset.marketing.social_text_post", "concept_confirmed", "concept_approval"): "publish_example",
    ("preset.marketing.social_text_post", "pending_approval", "external_publish"): "channel_auto_publish",
    ("preset.marketing.video_production", "animatic", "structure_approval"): "publish_example",
    ("preset.marketing.video_production", "concept_confirmed", "concept_approval"): "publish_example",
    ("preset.marketing.video_production", "pending_approval", "external_publish"): "channel_auto_publish",
    ("preset.marketing.video_production", "structure_passed", "generation_budget"): "publish_example",
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


async def _platform_gate_census() -> dict[tuple[str, str, str], str | None]:
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.models.event_definition import EventDefinition
    from app.routers.events import gate_verdict_next_action_kind

    engine = create_async_engine(_async_url())
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as s:
            definitions = (await s.execute(
                select(EventDefinition).where(EventDefinition.org_id.is_(None), EventDefinition.enabled.is_(True))
            )).scalars().all()
    finally:
        await engine.dispose()
    census: dict[tuple[str, str, str], str | None] = {}
    for definition in definitions:
        for stage, meta in (definition.stage_metadata or {}).items():
            gate = (meta or {}).get("gate") if isinstance(meta, dict) else None
            if gate:
                census[(definition.key, stage, gate["type"])] = gate_verdict_next_action_kind(definition, stage, gate["type"])
    return census


async def test_every_platform_gate_verdict_next_action_is_pinned():
    census = await _platform_gate_census()
    assert census == _EXPECTED, "\n".join(f"{k}: {v!r}" for k, v in sorted(census.items()))


async def test_server_advanced_next_stages_never_get_a_publish_example():
    """뉴스레터 발송 게이트 뒤 send_checked는 서버가 낸다 — 발행 예시가 아니다."""
    census = await _platform_gate_census()
    assert census[("preset.marketing.newsletter", "send_requested", "newsletter_send")] == "server_sends"
    assert census[("preset.marketing.newsletter", "review", "external_publish")] == "channel_auto_publish"
