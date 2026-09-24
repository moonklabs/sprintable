"""story #4174 후속(PO 2026-09-24) — 블로그 레시피 `pending_approval`이 «승인은 이 stage 밖(결재함의 초안 게이트)»임을 정의에
선언(`approval: {"surface": "draft_gate"}`, alembic 0401). 적용 창이 이 선언으로 «사람이 일하는 단계»와 가른다(FE
`recipe-role-slots.ts`). 여기서는 ① 선언 모양 검증(닫힌 어휘 · `surface` 하나 · `gate`와 동시 선언 금지) ② migrated DB의 실제
블로그 정의가 선언을 싣고 검증을 통과하며 0400의 `action_i18n`을 지우지 않았는지."""
from __future__ import annotations

import os

import pytest

from app.services.event_definition_registry import InvalidStageMetadataError, validate_stage_metadata

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

_SCHEMA = {"properties": {"stage": {"enum": ["wait", "review"]}}}


def _meta(**extra) -> dict:
    return {"wait": {"role": "Director", "action": "기다리기", **extra}}


def test_approval_surface_draft_gate_is_accepted():
    validate_stage_metadata(_SCHEMA, _meta(approval={"surface": "draft_gate"}))


@pytest.mark.parametrize("approval", [
    {"surface": "chat"},                                  # 닫힌 어휘 밖
    {"surface": "draft_gate", "approver": "org_owner"},  # 승인자는 싣지 않는다(두 번째 원천 금지)
    {},                                                   # surface 없음
    "draft_gate",                                         # object 아님
])
def test_malformed_approval_is_rejected(approval):
    with pytest.raises(InvalidStageMetadataError):
        validate_stage_metadata(_SCHEMA, _meta(approval=approval))


@pytest.mark.parametrize("value", [[], {}, 1])
@pytest.mark.parametrize("field", ["approval.surface", "gate.approver"])
def test_non_string_closed_vocabulary_value_is_rejected_not_type_error(field, value):
    """까디르 4594 codex P2 — 목록·객체는 frozenset 멤버십에서 TypeError(등록·수정 API 500)였다. 400이 되게 검증 오류로."""
    extra = (
        {"approval": {"surface": value}} if field == "approval.surface"
        else {"gate": {"type": "concept_approval", "approver": value}}
    )
    with pytest.raises(InvalidStageMetadataError):
        validate_stage_metadata(_SCHEMA, _meta(**extra))


def test_approval_and_gate_together_are_rejected():
    with pytest.raises(InvalidStageMetadataError, match="both gate and approval"):
        validate_stage_metadata(_SCHEMA, _meta(
            approval={"surface": "draft_gate"}, gate={"type": "concept_approval", "approver": "org_owner"},
        ))


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
@pytest.mark.anyio
async def test_migrated_blog_definition_declares_the_surface_and_still_validates():
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
            row = (await conn.execute(text(
                "SELECT payload_schema, stage_metadata FROM event_definitions "
                "WHERE org_id IS NULL AND key = 'preset.marketing.blog_article'"
            ))).one()
    finally:
        await engine.dispose()
    payload_schema, stage_metadata = row
    assert stage_metadata["pending_approval"]["approval"] == {"surface": "draft_gate"}
    assert "gate" not in stage_metadata["pending_approval"]
    assert stage_metadata["pending_approval"]["action_i18n"]["en"]  # 0400이 넣은 값이 그대로(jsonb_set 한 경로만)
    assert all("approval" not in meta for slug, meta in stage_metadata.items() if slug != "pending_approval")
    validate_stage_metadata(payload_schema, stage_metadata)
