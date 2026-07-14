"""에이전트 발견성 3층 fix(story 037a8aa8·78f07614 그라운딩 후속·PO 판정) 실증.

①툴셋: ui-designer/design-system role_templates에 canvas 그룹 부여(migration 0182).
③MCP description: canvas 11종에 "언제 쓰는지" ⭐트리거 1줄 추가 — 기계적 서술은 그대로 유지.
②(role_behaviors 문구)는 유나+PO 문구 확定 후 별도 커밋으로 합류 예정 — 이 스토리 스코프 밖."""
from __future__ import annotations

import os

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

_CANVAS_TOOL_NAMES = (
    "sprintable_create_artifact", "sprintable_get_artifact", "sprintable_list_artifacts",
    "sprintable_list_artifact_comments", "sprintable_add_artifact_comment",
    "sprintable_edit_artifact", "sprintable_propose_canonical_version",
    "sprintable_list_spec_pins", "sprintable_create_spec_pin", "sprintable_update_spec_pin",
    "sprintable_delete_spec_pin",
)


# ── ① role_templates canvas 그룹 부여(realdb) ──────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
@pytest.mark.anyio
async def test_ui_designer_and_design_system_have_canvas_group():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy import select

    from app.models.role_template import RoleTemplate

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            rows = (await s.execute(
                select(RoleTemplate).where(RoleTemplate.slug.in_(("ui-designer", "design-system")))
            )).scalars().all()
            by_slug = {r.slug: r for r in rows}
            assert "canvas" in by_slug["ui-designer"].default_tool_groups
            assert "canvas" in by_slug["design-system"].default_tool_groups
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
@pytest.mark.anyio
async def test_deferred_roles_not_granted_canvas_this_round():
    """PO 판정: pm/technical-writer/ux-researcher read는 이번 라운드 보류(과부여 회피)."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy import select

    from app.models.role_template import RoleTemplate

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            rows = (await s.execute(
                select(RoleTemplate).where(RoleTemplate.slug.in_(("pm", "technical-writer", "ux-researcher")))
            )).scalars().all()
            for r in rows:
                assert "canvas" not in r.default_tool_groups, f"{r.slug}는 이번 라운드 보류 대상"
    finally:
        await engine.dispose()


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── ③ MCP description "언제 쓰는지" 트리거 실증 ─────────────────────────────

def test_canvas_tool_descriptions_have_usage_trigger():
    """canvas 11종 전부 ⭐트리거 문구를 갖는다(기계적 서술만 있던 78f07614 그라운딩 갭 봉인)."""
    import os as _os
    _os.environ.setdefault("SPRINTABLE_API_URL", "http://test")
    _os.environ.setdefault("AGENT_API_KEY", "sk_test")
    from sprintable_mcp.server import mcp

    tools = mcp._tool_manager._tools
    for name in _CANVAS_TOOL_NAMES:
        assert name in tools, f"{name} 미등록"
        desc = tools[name].description
        assert "⭐" in desc, f"{name} description에 사용시점 트리거(⭐)가 없음: {desc!r}"


def test_create_artifact_trigger_mentions_ui_design_visual_deliverable():
    """PO 예시 문구 취지 반영 확인 — UI/디자인/시각 산출물 키워드."""
    import os as _os
    _os.environ.setdefault("SPRINTABLE_API_URL", "http://test")
    _os.environ.setdefault("AGENT_API_KEY", "sk_test")
    from sprintable_mcp.server import mcp

    desc = mcp._tool_manager._tools["sprintable_create_artifact"].description
    assert "UI" in desc or "디자인" in desc or "시각 산출물" in desc
