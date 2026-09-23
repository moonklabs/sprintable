"""story #4176(E-RECIPE-2·레시피 4호) — SNS 포스트 프리셋 2종(0395 시드)의 실 PG 계약.

AC1 시드: org_id NULL로 두 정의가 있고, 레지스트리 검증 함수(event_definition_registry)를 그대로
  통과한다(시드는 raw SQL이라 등록 API의 검증을 안 탄다 — 여기서 같은 검증을 대신 건다).
AC2 멘션 자기설명(#4076): 게이트가 없는 각 stage를 실제 렌더러(_render_event_message_content)에
  넣으면 역할·할 일·다음 단계·발행 예시가 나오고, 이미지 첨부 단계는 attach_image 힌트를 싣는다.
AC3 봉인 필드(#4085): 다음 stage가 봉인 필드를 요구하는 게이트를 열면, 그 필드가 payload_schema에
  열려 있어야 한다 — 렌더러가 예시에 estimated_cost_minor를 실어도 스키마(additionalProperties
  false)가 막으면 에이전트가 따라 한 발행이 422로 죽는다.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]

_CARD_NEWS = "preset.marketing.social_card_news"
_TEXT_POST = "preset.marketing.social_text_post"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _with_session(fn):
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(_async_url())
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as s:
            return await fn(s)
    finally:
        await engine.dispose()


async def _definition(session, key: str):
    from sqlalchemy import select

    from app.models.event_definition import EventDefinition

    row = (await session.execute(
        select(EventDefinition).where(EventDefinition.key == key, EventDefinition.org_id.is_(None))
    )).scalar_one_or_none()
    assert row is not None, f"{key} 시드가 안 보임 — DB가 alembic heads인지 확인"
    return row


async def test_presets_seeded_as_platform_definitions_and_pass_registry_validation():
    from app.services import event_definition_registry as reg

    async def body(s):
        for key in (_CARD_NEWS, _TEXT_POST):
            d = await _definition(s, key)
            assert d.enabled is True
            reg.validate_event_definition_key(d.key, org_id=None, org_slug=None)
            reg.validate_event_routing(d.routing)
            reg.validate_event_payload_schema_shape(d.payload_schema)
            reg.validate_block_template(d.block_template)
            reg.validate_block_template_refs(d.payload_schema, d.block_template)
            reg.validate_stage_metadata(d.payload_schema, d.stage_metadata)
            reg.validate_role_actor_kinds(d.stage_metadata, d.role_actor_kinds)

    await _with_session(body)


def _stage_order(d) -> list[str]:
    return list(d.payload_schema["properties"]["stage"]["enum"])


async def test_every_ungated_stage_renders_self_describing_mention():
    from app.routers.events import _render_event_message_content

    async def body(s):
        org_id = uuid.uuid4()
        work_item_id = str(uuid.uuid4())
        for key in (_CARD_NEWS, _TEXT_POST):
            d = await _definition(s, key)
            order = _stage_order(d)
            for i, stage in enumerate(order):
                meta = d.stage_metadata[stage]
                if meta.get("gate"):
                    continue  # 게이트 stage는 «승인 대기» 문구(#4076 스코프 B) — 발행 예시가 없는 게 계약.
                payload = {"stage": stage, "work_item_type": "story", "work_item_id": work_item_id}
                content = await _render_event_message_content(s, org_id=org_id, definition=d, payload=payload)
                assert f"- 할 일: {meta['action']}" in content, (key, stage, content)
                if i + 1 < len(order):
                    assert "publish_event(" in content, (key, stage, content)
        return None

    await _with_session(body)


async def test_card_news_image_stages_carry_their_tool_hints():
    from app.routers.events import _render_event_message_content

    async def body(s):
        d = await _definition(s, _CARD_NEWS)
        org_id = uuid.uuid4()
        base = {"work_item_type": "story", "work_item_id": str(uuid.uuid4())}
        editing = await _render_event_message_content(s, org_id=org_id, definition=d, payload={**base, "stage": "editing"})
        assert "attach_channel_post_image" in editing, editing
        generation = await _render_event_message_content(
            s, org_id=org_id, definition=d, payload={**base, "stage": "live_generation"},
        )
        assert "get_generation_connector" in generation, generation

    await _with_session(body)


async def test_sealed_fields_of_next_gate_are_open_in_payload_schema():
    from app.services.recipe_gate_hooks import _GATE_TYPE_SEALED_FIELDS

    async def body(s):
        checked = 0
        for key in (_CARD_NEWS, _TEXT_POST):
            d = await _definition(s, key)
            props = d.payload_schema["properties"]
            for stage, meta in d.stage_metadata.items():
                gate = meta.get("gate") or {}
                for spec in _GATE_TYPE_SEALED_FIELDS.get(gate.get("type"), ()):
                    checked += 1
                    assert spec.name in props, f"{key}.{stage}: 게이트 {gate['type']}의 봉인 필드 {spec.name}가 payload_schema에 없음"
        assert checked >= 1, "card_news의 generation_budget 게이트가 사라졌다 — AC3 전제 붕괴"

    await _with_session(body)


async def test_budget_stage_publish_example_carries_cost_and_passes_schema():
    """렌더러 두 곳이 공유하는 예시 생성 함수(#4085)를 이 프리셋의 실제 게이트 선언에 걸어, 에이전트가
    그대로 복사할 예시 payload에 estimated_cost_minor가 실리고 그 payload가 스키마 검증을 통과하는지."""
    from app.routers.events import _resolve_sealed_field_specs_and_payload
    from app.services.event_definition_registry import validate_event_payload

    async def body(s):
        d = await _definition(s, _CARD_NEWS)
        base = {"stage": "budget_approved", "work_item_type": "story", "work_item_id": str(uuid.uuid4())}
        specs, example = _resolve_sealed_field_specs_and_payload(d.stage_metadata["budget_approved"]["gate"], base)
        assert [sp.name for sp in specs] == ["estimated_cost_minor"]
        assert isinstance(example.get("estimated_cost_minor"), int)
        validate_event_payload(d.payload_schema, example)

    await _with_session(body)
