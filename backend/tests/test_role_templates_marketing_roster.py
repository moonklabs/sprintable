"""A2A 발견 스킬 갭(story 10c6ecbd) 후속 — 마케팅 직군 2종 role_templates seed(0160).

0157(E-RECRUIT S14) 견고 기준을 그대로 적용: role_behaviors 5요소 구조·검증된 도구명만·
최소 1개 non-core tool_group·default_tool_groups는 실 vocabulary(mcp_toolset.ALL_GROUPS)만.
"""
from __future__ import annotations

import importlib.util
import re
from pathlib import Path

_MIGRATION = Path(__file__).parent.parent / "alembic" / "versions" / "0160_role_templates_marketing_roster.py"


def _load_migration():
    spec = importlib.util.spec_from_file_location("rev_0160", _MIGRATION)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_migration_0160_chains_off_0159():
    mod = _load_migration()
    assert mod.revision == "0160"
    assert mod.down_revision == "0159"
    assert callable(mod.upgrade) and callable(mod.downgrade)


def test_seed_covers_exactly_2_marketing_roles():
    mod = _load_migration()
    slugs = {row[0] for row in mod._SEED}
    assert slugs == {"growth-hacker", "performance-marketer"}
    # 기존 24직무와 절대 겹치지 않아야(slug UNIQUE 제약 위반 방지).
    assert "growth-engineer" not in slugs  # 유사 이름이라 특히 확認


def test_seed_tool_groups_are_valid_vocabulary_and_exclude_admin_groups():
    from app.services.mcp_toolset import ALL_GROUPS

    mod = _load_migration()
    excluded = {"admin", "rewards", "webhooks", "audit", "agent_runs"}
    for slug, _name, _category, _description, tool_groups, _recipe in mod._SEED:
        assert tool_groups, f"{slug} has empty default_tool_groups"
        unknown = set(tool_groups) - set(ALL_GROUPS)
        assert not unknown, f"{slug} references unknown group(s): {unknown}"
        assert not (set(tool_groups) & excluded), f"{slug} leaks an excluded group: {tool_groups}"


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


def test_both_roles_compose_without_error_and_validate_against_default_tool_groups():
    """S2 교차검증 동형: compose_prompt가 크래시 없이 완주하고, 치트시트가 실 default_tool_groups
    로부터만 파생되는지(환각 0·G3 단일소스)."""
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


def test_recipe_slugs_reference_known_builtin_recipes():
    from app.routers.workflow_recipes import _BUILTIN_BY_ID

    mod = _load_migration()
    for slug, _name, _category, _description, _tool_groups, recipe_slug in mod._SEED:
        if recipe_slug is not None:
            assert recipe_slug in _BUILTIN_BY_ID, f"{slug}: unknown recipe slug {recipe_slug!r}"


def test_categories_are_distinct_from_engineering_to_avoid_eng_mismapping():
    """선생님 지적(2026-07-07): 마케팅 역할을 엔지니어링 template에 우겨넣지 말 것 — category가
    growth/marketing이지 engineering이 아닌지 회귀 잠금."""
    mod = _load_migration()
    categories = {row[0]: row[2] for row in mod._SEED}
    assert categories["growth-hacker"] == "growth"
    assert categories["performance-marketer"] == "marketing"
