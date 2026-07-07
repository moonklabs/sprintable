"""E-RECRUIT S1 (story a47e7374): role_templates 카탈로그 모델 + seed + GET 엔드포인트.

Alembic 경로로 확정(PO crux 2026-07-05 — packages/db/supabase 경로는 죽은 인프라, 0002_disable_rls.py
가 명시한 FastAPI-authz SSOT 원칙과 정합). RLS/SECURITY DEFINER 불요 — 인가는 애플리케이션 레이어.
"""
from __future__ import annotations

import importlib.util
import os
import uuid
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import text

_MIGRATION = Path(__file__).parent.parent / "alembic" / "versions" / "0156_role_templates.py"


def _load_migration():
    spec = importlib.util.spec_from_file_location("rev_0156", _MIGRATION)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_migration_0156_chains_off_0155():
    mod = _load_migration()
    assert mod.revision == "0156"
    assert mod.down_revision == "0155"
    assert callable(mod.upgrade) and callable(mod.downgrade)


def test_seed_covers_exactly_p0_four_roles():
    mod = _load_migration()
    slugs = {row[0] for row in mod._SEED}
    assert slugs == {"frontend", "backend", "qa", "pm"}


def test_seed_tool_groups_exclude_admin_and_destructive_only_groups():
    """AC: default_tool_groups 는 직무별 최소권한 — admin/rewards/webhooks/audit/agent_runs 제외."""
    mod = _load_migration()
    excluded = {"admin", "rewards", "webhooks", "audit", "agent_runs"}
    for slug, _name, _category, _description, tool_groups, _recipe in mod._SEED:
        assert not (set(tool_groups) & excluded), f"{slug} leaks an excluded group: {tool_groups}"
        assert tool_groups, f"{slug} has empty default_tool_groups"


def test_role_behaviors_reference_verified_tool_names_only():
    """AC: '검증된 도구 이름만' — role_behaviors 안의 sprintable_* 언급이 실제 등록 도구명과 일치."""
    import re

    mod = _load_migration()
    from sprintable_mcp.server import _TOOL_DEFS

    real_names = {name for name, *_ in _TOOL_DEFS} | {"ping"}
    for slug, behaviors in mod._ROLE_BEHAVIORS.items():
        mentioned = set(re.findall(r"`(sprintable_[a-z_]+)`", behaviors))
        assert mentioned, f"{slug} role_behaviors mentions no sprintable_* tools"
        unknown = mentioned - real_names
        assert not unknown, f"{slug} role_behaviors invents non-existent tool names: {unknown}"


def test_model_field_shape():
    from app.models.role_template import RoleTemplate

    cols = {c.name for c in RoleTemplate.__table__.columns}
    assert cols == {
        "id", "slug", "name", "category", "description", "role_behaviors",
        "default_tool_groups", "default_workflow_recipe_slug", "runtime_overrides",
        "is_builtin", "is_published", "tier", "version", "created_at", "updated_at",
        # 카탈로그 트랙 S1(0161, 문서 role-template-crud-api-crux §4).
        "division", "emoji", "skills",
    }


# ─── 실 Postgres — 실 마이그 적용 + GET 엔드포인트 ────────────────────────────

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _engine():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


@pytest.mark.anyio
@pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")
async def test_list_role_templates_returns_seeded_four_roles_realdb():
    from app.routers.role_templates import list_role_templates

    eng, Session = await _engine()
    try:
        async with Session() as s:
            out = await list_role_templates(session=s, org_id=uuid.uuid4(), _auth=None)
        slugs = {rt.slug for rt in out}
        assert {"frontend", "backend", "qa", "pm"} <= slugs
        # 목록 응답엔 role_behaviors(md 본문) 없음(페이로드 절감)
        assert not hasattr(out[0], "role_behaviors")
    finally:
        await eng.dispose()


@pytest.mark.anyio
@pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")
async def test_get_role_template_by_slug_includes_behaviors_realdb():
    from app.routers.role_templates import get_role_template

    eng, Session = await _engine()
    try:
        async with Session() as s:
            out = await get_role_template("backend", session=s, org_id=uuid.uuid4(), _auth=None)
        assert out.slug == "backend"
        assert "sprintable_" in out.role_behaviors
        assert out.default_tool_groups == ["stories", "tasks", "epics", "chat", "docs"]
        assert out.is_builtin is True
    finally:
        await eng.dispose()


@pytest.mark.anyio
@pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")
async def test_get_role_template_unknown_slug_404_realdb():
    from app.routers.role_templates import get_role_template

    eng, Session = await _engine()
    try:
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await get_role_template("nonexistent-role", session=s, org_id=uuid.uuid4(), _auth=None)
            assert ei.value.status_code == 404
    finally:
        await eng.dispose()


@pytest.mark.anyio
@pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")
async def test_unpublished_role_template_hidden_from_list_and_get_realdb():
    """is_published=False 는 목록/단건 둘 다 숨김(삭제 아닌 게이트)."""
    from app.routers.role_templates import get_role_template, list_role_templates

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await s.execute(text(
                "INSERT INTO role_templates (slug, name, category, role_behaviors, "
                "default_tool_groups, is_published) VALUES "
                "('draft-role', 'Draft', 'test', 'wip', ARRAY['stories'], false)"
            ))
            await s.commit()
        async with Session() as s:
            listed = await list_role_templates(session=s, org_id=uuid.uuid4(), _auth=None)
            assert "draft-role" not in {rt.slug for rt in listed}
            with pytest.raises(HTTPException) as ei:
                await get_role_template("draft-role", session=s, org_id=uuid.uuid4(), _auth=None)
            assert ei.value.status_code == 404
    finally:
        async with Session() as s:
            await s.execute(text("DELETE FROM role_templates WHERE slug = 'draft-role'"))
            await s.commit()
        await eng.dispose()
