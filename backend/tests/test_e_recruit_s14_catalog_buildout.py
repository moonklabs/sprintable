"""E-RECRUIT S14 (story a4ccf431): 직무 카탈로그 세분화 빌드아웃 — 18 신규 role_templates.

문서 `e-recruit-catalog-roster`(PO 큐레이트) 반영. 견고 기준(선생님): 전 role이 실제로 일하는
팀원 — role_behaviors 5요소 구조·검증된 도구명만·최소 1개 non-core tool_group.
"""
from __future__ import annotations

import importlib.util
import os
import re
import uuid
from pathlib import Path

import pytest

_MIGRATION = Path(__file__).parent.parent / "alembic" / "versions" / "0157_role_templates_catalog_buildout.py"


def _load_migration():
    spec = importlib.util.spec_from_file_location("rev_0157", _MIGRATION)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_migration_0157_chains_off_0156():
    mod = _load_migration()
    assert mod.revision == "0157"
    assert mod.down_revision == "0156"
    assert callable(mod.upgrade) and callable(mod.downgrade)


def test_seed_covers_exactly_18_new_roles():
    mod = _load_migration()
    slugs = {row[0] for row in mod._SEED}
    assert len(slugs) == 18
    # 기존 4직무(0156)와 절대 겹치지 않아야(별개 마이그 — slug UNIQUE 제약 위반 방지).
    assert slugs.isdisjoint({"frontend", "backend", "qa", "pm"})


def test_seed_tool_groups_are_valid_vocabulary_and_exclude_admin_groups():
    """AC: default_tool_groups는 실 vocabulary(mcp_toolset.ALL_GROUPS)만 — admin/destructive
    -only 그룹(rewards/webhooks/audit/agent_runs) 제외. 로스터 원문 오탈자(retros/standups
    복수형)가 아니라 실제 단수형(retro/standup)인지도 여기서 잡는다."""
    from app.services.mcp_toolset import ALL_GROUPS

    mod = _load_migration()
    excluded = {"admin", "rewards", "webhooks", "audit", "agent_runs"}
    for slug, _name, _category, _description, tool_groups, _recipe in mod._SEED:
        assert tool_groups, f"{slug} has empty default_tool_groups"
        unknown = set(tool_groups) - set(ALL_GROUPS)
        assert not unknown, f"{slug} references unknown group(s): {unknown}"
        assert not (set(tool_groups) & excluded), f"{slug} leaks an excluded group: {tool_groups}"


def test_seed_each_role_has_at_least_one_non_core_group():
    """까심 불변식(S1 선례): 각 직무 최소 1개 non-core tool_group — 이름만 반쪽인 role 방지."""
    mod = _load_migration()
    for slug, _name, _category, _description, tool_groups, _recipe in mod._SEED:
        assert len(tool_groups) >= 1, f"{slug} must grant at least one tool group"


def test_role_behaviors_reference_verified_tool_names_only():
    """견고 기준: role_behaviors 안의 sprintable_* 언급이 실제 등록 도구명과 100% 일치(환각 0)."""
    mod = _load_migration()
    from sprintable_mcp.server import _TOOL_DEFS

    real_names = {name for name, *_ in _TOOL_DEFS} | {"ping"}
    for slug, behaviors in mod._ROLE_BEHAVIORS.items():
        mentioned = set(re.findall(r"`(sprintable_[a-z_]+)`", behaviors))
        assert mentioned, f"{slug} role_behaviors mentions no sprintable_* tools"
        unknown = mentioned - real_names
        assert not unknown, f"{slug} role_behaviors invents non-existent tool names: {unknown}"


def test_all_18_roles_compose_without_error_and_validate_against_default_tool_groups():
    """견고 기준(S2 교차검증): 각 role의 compose_prompt가 크래시 없이 완주하고, 치트시트가
    실 default_tool_groups 로부터만 파생되는지(환각 0·G3 단일소스)."""
    from types import SimpleNamespace
    from app.services.agent_recruiter import compose_prompt, validate_tool_groups
    from app.services.mcp_toolset import ALL_TOOL_NAMES

    mod = _load_migration()
    for slug, name, _category, _description, tool_groups, _recipe_slug in mod._SEED:
        validate_tool_groups(tool_groups)  # 예외 없어야 함
        role = SimpleNamespace(
            name=name, role_behaviors=mod._ROLE_BEHAVIORS[slug],
            default_tool_groups=tool_groups, runtime_overrides={},
        )
        out = compose_prompt(role, None, "claude-code")
        mentioned = set(re.findall(r"`(sprintable_[a-z_]+)`", out))
        assert mentioned <= set(ALL_TOOL_NAMES), (
            f"{slug}: invented tool names {mentioned - set(ALL_TOOL_NAMES)}"
        )


def test_data_analyst_uses_custom_non_claim_opening():
    """data-analyst는 stories/tasks 그룹이 없어 표준 claim 오프닝이 성립하지 않는다 —
    커스텀 오프닝(분석→가설→공유)을 쓰는지 확인."""
    mod = _load_migration()
    tool_groups = next(tg for slug, _n, _c, _d, tg, _r in mod._SEED if slug == "data-analyst")
    assert "stories" not in tool_groups
    assert "tasks" not in tool_groups
    behaviors = mod._ROLE_BEHAVIORS["data-analyst"]
    assert "sprintable_claim_story" not in behaviors  # 표준 claim 오프닝 안 씀
    assert "sprintable_get_project_overview" in behaviors  # 커스텀 분석 오프닝 사용


def test_recipe_slugs_reference_known_builtin_recipes():
    """default_workflow_recipe_slug가 실제 존재하는 builtin recipe를 가리키는지."""
    from app.routers.workflow_recipes import _BUILTIN_BY_ID

    mod = _load_migration()
    for slug, _name, _category, _description, _tool_groups, recipe_slug in mod._SEED:
        if recipe_slug is not None:
            assert recipe_slug in _BUILTIN_BY_ID, f"{slug}: unknown recipe slug {recipe_slug!r}"


# ─── 실 Postgres — 실 마이그 적용 + GET 엔드포인트(22직무 전체) ────────────────

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
async def test_list_role_templates_returns_all_22_roles_realdb():
    from app.routers.role_templates import list_role_templates

    eng, Session = await _engine()
    try:
        async with Session() as s:
            out = await list_role_templates(session=s, org_id=uuid.uuid4(), _auth=None)
        slugs = {rt.slug for rt in out}
        expected_new = {
            "mobile", "devops", "sre", "data-engineer", "ai-engineer", "security-engineer",
            "code-reviewer", "ui-designer", "ux-researcher", "design-system", "product-analyst",
            "technical-writer", "qa-automation", "accessibility", "scrum-master",
            "release-manager", "growth-engineer", "data-analyst",
        }
        assert expected_new <= slugs
        assert len(slugs) == 22
    finally:
        await eng.dispose()


@pytest.mark.anyio
@pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")
async def test_get_role_template_data_analyst_by_slug_realdb():
    from app.routers.role_templates import get_role_template

    eng, Session = await _engine()
    try:
        async with Session() as s:
            out = await get_role_template("data-analyst", session=s, org_id=uuid.uuid4(), _auth=None)
        assert out.slug == "data-analyst"
        assert out.category == "growth"
        assert "stories" not in out.default_tool_groups
        assert "analytics" in out.default_tool_groups
        assert "Data Analyst" in out.role_behaviors
    finally:
        await eng.dispose()
