"""story #4243 — 플랫폼 레시피의 역할별 사람/에이전트 선언(role_actor_kinds) 전수 가드(migrated DB · non-destructive).

시드 마이그레이션(0403)이 실은 선언을 실제 행에서 본다. 클래스 가드: 플랫폼 사이클형 프리셋(`preset.*` · org_id NULL · stage_metadata
있음)은 **모든 역할**에 kind를 선언한다 — 선언 빠진 새 프리셋은 여기서 RED(범용 적용 창이 그 역할을 에이전트로만 묶게 되는 클래스
재발 방지)."""
from __future__ import annotations

import os

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]

# PO 확정(2026-09-24) — 이름부터 한쪽인 역할만 human/agent, 그 밖의 일반 역할은 either.
_EXPECTED_WORKFLOW = {
    "preset.workflow.agent_solo": {"Agent": "agent"},
    "preset.workflow.solo": {"Worker": "either"},
    "preset.workflow.kanban": {"Member": "either"},
    "preset.workflow.kanban_simple": {"Any": "either", "Dev": "either", "Lead": "either"},
    "preset.workflow.scrum_3step": {"PO": "either", "Dev": "either", "QA": "either"},
    "preset.workflow.two_step": {"Maker": "either", "Reviewer": "either"},
    "preset.workflow.three_step": {"Executor": "either", "Reviewer": "either", "Approver": "either"},
    "preset.workflow.loop_agency": {"Human": "human", "PO": "either", "Agent": "agent", "Any": "either"},
}


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _platform_rows():
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
            return (await conn.execute(text(
                "SELECT key, stage_metadata, role_actor_kinds FROM event_definitions "
                "WHERE org_id IS NULL AND key LIKE 'preset.%' AND stage_metadata <> '{}'::jsonb"
            ))).all()
    finally:
        await engine.dispose()


async def test_every_platform_recipe_declares_a_kind_for_every_role():
    from app.services.event_definition_registry import validate_role_actor_kinds

    rows = await _platform_rows()
    missing = []
    for key, meta, kinds in rows:
        validate_role_actor_kinds(meta, kinds)  # 선언이 모양 검증도 통과(닫힌 어휘 · 실재하는 role)
        roles = {m.get("role") for m in (meta or {}).values() if isinstance(m, dict) and m.get("role")}
        missing += [f"{key}:{role}" for role in sorted(roles) if role not in (kinds or {})]
    assert missing == [], f"role_actor_kinds 선언이 없는 플랫폼 레시피 역할: {missing}"


async def test_workflow_presets_carry_the_po_confirmed_table():
    by_key = {key: kinds for key, _meta, kinds in await _platform_rows()}
    for key, expected in _EXPECTED_WORKFLOW.items():
        assert by_key.get(key) == expected, key
