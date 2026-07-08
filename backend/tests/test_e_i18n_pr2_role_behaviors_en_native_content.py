"""E-I18N EN 콘텐츠 PR2(story d6e3f407) — migration 0166의 EN 네이티브 저작 콘텐츠 검증(no-DB).

0163/S1 선례와 동형: 마이그레이션 모듈을 직접 로드해(importlib) DB 없이 콘텐츠 자체의
구조적 정합성(전체 role 커버·도구명 환각 0·release_notes 필드 커버)을 빠르게 검증한다.
실 DB 적용 후 상태는 test_migration_0166_..._realdb.py가 별도로 검증.
"""
from __future__ import annotations

import importlib.util
import re
from pathlib import Path

import pytest

_MIGRATION = Path(__file__).parent.parent / "alembic" / "versions" / "0166_role_templates_release_notes_en_native_content.py"
_S1_MIGRATION = Path(__file__).parent.parent / "alembic" / "versions" / "0156_role_templates.py"
_S14_MIGRATION = Path(__file__).parent.parent / "alembic" / "versions" / "0157_role_templates_catalog_buildout.py"
_MARKETING_MIGRATION = Path(__file__).parent.parent / "alembic" / "versions" / "0160_role_templates_marketing_roster.py"


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _all_ko_slugs() -> set[str]:
    """실 role_templates 24행의 slug 전체(S1 4 + S14 18 + marketing 2) — 0166의 EN 커버리지
    기준선(실 시드 마이그를 참조, 하드코딩 중복 나열 안 함)."""
    slugs: set[str] = set()
    for mod, key in (
        (_load(_S1_MIGRATION, "rev_0156_pr2check"), "_SEED"),
        (_load(_S14_MIGRATION, "rev_0157_pr2check"), "_SEED"),
        (_load(_MARKETING_MIGRATION, "rev_0160_pr2check"), "_SEED"),
    ):
        slugs |= {row[0] for row in getattr(mod, key)}
    return slugs


def test_en_role_behaviors_covers_every_ko_role():
    mod = _load(_MIGRATION, "rev_0166")
    ko_slugs = _all_ko_slugs()
    en_slugs = set(mod._ROLE_BEHAVIORS_EN.keys())
    assert en_slugs == ko_slugs, (
        f"missing EN: {ko_slugs - en_slugs} / extra EN(ko에 없는 slug): {en_slugs - ko_slugs}"
    )


def test_en_role_behaviors_reference_verified_tool_names_only():
    """0163 교훈과 동형 — EN 신규 저작도 환각 도구명 0건이어야."""
    mod = _load(_MIGRATION, "rev_0166")
    from sprintable_mcp.server import _TOOL_DEFS

    real_names = {name for name, *_ in _TOOL_DEFS} | {"ping"}
    for slug, behaviors in mod._ROLE_BEHAVIORS_EN.items():
        mentioned = set(re.findall(r"`(sprintable_[a-z_]+)`", behaviors))
        assert mentioned, f"{slug} EN role_behaviors mentions no sprintable_* tools"
        unknown = mentioned - real_names
        assert not unknown, f"{slug} EN role_behaviors invents non-existent tool names: {unknown}"


def test_en_role_behaviors_are_english_not_korean():
    """네이티브 저작 검증(정직화) — EN 컬럼에 한글 문자가 섞이면 안 됨(번역 잔재/복붙 실수 가드)."""
    mod = _load(_MIGRATION, "rev_0166")
    hangul = re.compile(r"[가-힣]")
    for slug, behaviors in mod._ROLE_BEHAVIORS_EN.items():
        assert not hangul.search(behaviors), f"{slug} EN role_behaviors contains Hangul characters"


def test_en_role_behaviors_headings_match_locale_aware_compose_kit_sections():
    """compose_kit이 만드는 4섹션 표제(Sprintable Role Context/Workflow/...)와 이 role_behaviors
    자체 헤딩이 안 겹쳐도 되지만, role_behaviors 자체는 항상 '# {name} — Autonomous Operating
    Instructions'로 시작해야 한다(포맷 회귀 가드)."""
    mod = _load(_MIGRATION, "rev_0166")
    for slug, behaviors in mod._ROLE_BEHAVIORS_EN.items():
        assert behaviors.startswith("# "), f"{slug} EN role_behaviors doesn't start with a heading"
        assert "Autonomous Operating Instructions" in behaviors.splitlines()[0], slug


def test_release_notes_en_covers_all_four_notes():
    mod = _load(_MIGRATION, "rev_0166")
    expected_keys = {"2026-06-v1-5", "2026-06-v1-4", "2026-06-v1-3", "2026-05-v1-2"}
    assert set(mod._RELEASE_NOTES_EN.keys()) == expected_keys


def test_release_notes_en_have_title_summary_and_nonempty_items():
    mod = _load(_MIGRATION, "rev_0166")
    hangul = re.compile(r"[가-힣]")
    for note_key, data in mod._RELEASE_NOTES_EN.items():
        assert data["title"], note_key
        assert data["summary"], note_key
        assert data["items"], f"{note_key} has no items"
        for item in data["items"]:
            assert "text" in item and item["text"], f"{note_key} item missing text"
            assert not hangul.search(item["text"]), f"{note_key} item text contains Hangul"
        assert not hangul.search(data["title"]), note_key
        assert not hangul.search(data["summary"]), note_key


@pytest.mark.parametrize("slug_source", ["standard", "analyst"])
def test_all_en_roles_compose_via_compose_kit_without_error(slug_source):
    """S2/S14 교차검증 동형(EN 버전): EN role_behaviors가 실제로 compose_kit을 통과해 유효한
    kit을 내는지(통합 스모크) — role_behaviors_i18n에 en 키가 있는 것처럼 SimpleNamespace로
    duck-typing해 넘긴다."""
    import re as _re
    from types import SimpleNamespace

    from app.services.agent_recruiter import compose_kit
    from app.services.mcp_toolset import ALL_TOOL_NAMES

    mod = _load(_MIGRATION, "rev_0166")
    roles = mod._STANDARD_ROLES if slug_source == "standard" else mod._ANALYST_ROLES
    template = mod._STANDARD_TEMPLATE if slug_source == "standard" else mod._ANALYST_TEMPLATE

    for slug, data in roles.items():
        behaviors_en = template.format(**data)
        role = SimpleNamespace(
            name=data["name"],
            role_behaviors=f"(ko placeholder for {slug})",
            role_behaviors_i18n={"en": behaviors_en},
            default_tool_groups=["stories", "tasks", "chat", "docs"],
            runtime_overrides={},
        )
        kit = compose_kit(role, "claude-code", locale="en")
        assert behaviors_en in kit["role_context"]
        mentioned = set(_re.findall(r"`(sprintable_[a-z_]+)`", kit["role_context"]))
        assert mentioned <= set(ALL_TOOL_NAMES), (
            f"{slug}: invented tool names {mentioned - set(ALL_TOOL_NAMES)}"
        )
