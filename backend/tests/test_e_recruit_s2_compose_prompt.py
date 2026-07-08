"""E-RECRUIT S2 (story 58c37f17): `agent_recruiter.compose_prompt` — deterministic composer.

G3(단일 소스): 섹션[C] 도구 치트시트는 role_template.default_tool_groups → mcp_toolset.tool_group()
SSOT로만 파생(하드코딩 별도 목록 금지). G4(배달 분리): compose_prompt는 순수 합성만(네트워크/DB
호출 0) — 이 테스트들은 전부 인자만으로 호출하고 어떤 I/O 도 mock 하지 않는다(진짜 순수함 증명).
QA MINOR 하드닝: role_template.default_tool_groups 값이 실제 그룹 vocabulary 밖이면 fail-closed
(resolve_policy 자체의 fail-open 은 S3 스코프 — 여긴 손대지 않는다).
"""
from __future__ import annotations

import importlib.util
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.services.agent_recruiter import compose_prompt, validate_tool_groups
from app.services.mcp_toolset import ALL_GROUPS, ALL_TOOL_NAMES


def _role(**overrides) -> SimpleNamespace:
    defaults = dict(
        name="Backend Engineer",
        role_behaviors="당신은 백엔드 엔지니어입니다.",
        default_tool_groups=["stories", "tasks", "chat", "docs"],
        runtime_overrides={},
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


_RECIPE = {
    "name": "칸반 심플",
    "description": "할 일 → 진행 중 → 완료",
    "steps": [{"role": "Dev", "label": "진행", "pattern": "in_progress", "action": "작업 수행"}],
}


# ── validate_tool_groups ───────────────────────────────────────────────────────
def test_validate_tool_groups_accepts_real_groups():
    validate_tool_groups(["stories", "tasks", "chat"])  # 예외 없이 통과


def test_validate_tool_groups_rejects_unknown_group():
    with pytest.raises(ValueError, match="unknown group"):
        validate_tool_groups(["stories", "not-a-real-group"])


def test_validate_tool_groups_rejects_admin_typo_variants():
    """admin 자체도 ALL_GROUPS 밖(의도적 제외) — role_template 이 admin 을 담고 있으면 거부."""
    with pytest.raises(ValueError):
        validate_tool_groups(["admin"])


# ── compose_prompt — 순수성 + 결정론 ──────────────────────────────────────────
def test_compose_prompt_is_deterministic_same_input_same_output():
    """diffable — 동일 입력 두 번 호출 결과가 문자 그대로 동일(LLM 비호출 증명)."""
    role = _role()
    out1 = compose_prompt(role, _RECIPE, "claude-code")
    out2 = compose_prompt(role, _RECIPE, "claude-code")
    assert out1 == out2


def test_compose_prompt_contains_five_sections():
    role = _role()
    out = compose_prompt(role, _RECIPE, "claude-code")
    assert "채용 지침" in out  # [A]
    assert "Sprintable 사용법" in out  # [B]
    assert "사용 가능 도구 (치트시트)" in out  # [C]
    assert "애자일 자율 운영 룰" in out  # [D]
    assert "런타임 노트" in out  # [E]


def test_compose_prompt_section_a_includes_role_behaviors_verbatim():
    role = _role(role_behaviors="스스로 판단해 claim하고 소통하세요.")
    out = compose_prompt(role, _RECIPE, "claude-code")
    assert "스스로 판단해 claim하고 소통하세요." in out


def test_compose_prompt_handles_missing_recipe_gracefully():
    """recipe=None — 워크플로우 가이드 부분만 생략, 나머지 섹션은 정상 생성(크래시 없음)."""
    role = _role()
    out = compose_prompt(role, None, "claude-code")
    assert "사용 가능 도구 (치트시트)" in out
    assert "get_workflow_guide" in out  # 자율-pull 안내는 recipe 유무와 무관하게 항상 존재


def test_compose_prompt_includes_runtime_identifier():
    role = _role()
    out = compose_prompt(role, _RECIPE, "cursor")
    assert "`cursor`" in out


def test_compose_prompt_includes_runtime_override_when_present():
    role = _role(runtime_overrides={"claude-code": "CLAUDE.md 에 이 지침을 저장하세요."})
    out = compose_prompt(role, _RECIPE, "claude-code")
    assert "CLAUDE.md 에 이 지침을 저장하세요." in out


# ── 까심 QA 후속(story 6f6ac081, 2026-07-08): 런타임 노트가 커넥터-라우팅 런타임에도 정직해야 함 ──
def test_compose_prompt_mcp_native_runtime_says_no_setup_needed():
    role = _role()
    out = compose_prompt(role, _RECIPE, "claude-code")
    assert "별도 설정이 필요 없습니다" in out
    assert "SSE 커넥터" not in out


def test_compose_prompt_connector_only_runtime_gives_honest_setup_instructions():
    """전에는 grok/pi/hermes/openclaw/opencode 도 "별도 설정 불요"라는 거짓 안내를 받았다(까심
    `compose_prompt(runtime="grok")` 재현) — mcp_config=None인 커넥터-라우팅 런타임은 실제로
    connectors/{runtime}-sprintable/ 복사 + AGENT_API_KEY 설정 + 어댑터 실행이 필요하다."""
    role = _role()
    out = compose_prompt(role, _RECIPE, "grok")
    assert "별도 설정이 필요 없습니다" not in out
    assert "SSE 커넥터" in out
    assert "connectors/grok-sprintable/" in out
    assert "AGENT_API_KEY" in out


def test_compose_prompt_generic_connector_bucket_also_honest():
    role = _role()
    out = compose_prompt(role, _RECIPE, "connector")
    assert "별도 설정이 필요 없습니다" not in out
    assert "SSE 커넥터" in out


# ── E-I18N Phase A(story 11f1087c, PO GO 2026-07-08) — 코드 상수 locale 분기 ────────

def test_compose_prompt_default_locale_is_korean_backward_compatible():
    """locale 인자를 안 주면(기존 호출부·recruit_service.py) 정확히 예전과 동일한 한글 출력."""
    role = _role()
    out = compose_prompt(role, _RECIPE, "claude-code")
    assert "## 애자일 자율 운영 룰" in out
    assert "## Sprintable 사용법" in out
    assert "## 사용 가능 도구 (치트시트)" in out
    assert "## Agile Autonomous Operating Rules" not in out


def test_compose_prompt_english_locale_localizes_code_sections():
    """[B]/[C]/[D]/[E] 전부 영어로 나오되, [A](role_behaviors 데이터)는 아직 한글 그대로
    (Phase A 스코프 — 데이터 i18n은 Phase B/후속, 의도적)."""
    role = _role(role_behaviors="스스로 판단해 claim하고 소통하세요.")
    out = compose_prompt(role, _RECIPE, "claude-code", locale="en")
    assert "## Agile Autonomous Operating Rules" in out
    assert "## How to Use Sprintable" in out
    assert "## Available Tools (Cheat Sheet)" in out
    assert "## Runtime Notes" in out
    assert "MCP connection/scope was already configured" in out
    assert "## 애자일 자율 운영 룰" not in out
    # section [A]는 의도적으로 미번역(Phase A 스코프 밖)
    assert "스스로 판단해 claim하고 소통하세요." in out
    assert "# Backend Engineer — Recruitment Instructions" in out


def test_compose_prompt_english_connector_runtime_localized():
    role = _role()
    out = compose_prompt(role, _RECIPE, "grok", locale="en")
    assert "no separate setup is needed" not in out
    assert "SSE connector" in out
    assert "connectors/grok-sprintable/" in out
    assert "AGENT_API_KEY" in out


def test_compose_prompt_tool_names_and_group_labels_stay_unlocalized_identifiers():
    """도구/그룹 이름은 실 레지스트리 식별자라 en/ko 무관하게 그대로 — 래퍼 텍스트만 번역."""
    role = _role(default_tool_groups=["stories", "tasks"])
    out_ko = compose_prompt(role, None, "claude-code", locale="ko")
    out_en = compose_prompt(role, None, "claude-code", locale="en")
    for out in (out_ko, out_en):
        assert "`sprintable_claim_story`" in out
        assert "**stories**:" in out


# ── G3: 도구 치트시트 = 단일 소스(ALL_TOOL_NAMES) 파생, 환각 0 ─────────────────
def test_compose_prompt_tool_cheat_sheet_only_references_real_tool_names():
    role = _role(default_tool_groups=[
        "stories", "tasks", "epics", "sprints", "hypotheses", "chat", "docs",
        "analytics", "retro", "standup", "meetings", "notifications", "webhooks",
        "rewards", "audit", "agent_runs",
    ])
    out = compose_prompt(role, _RECIPE, "claude-code")
    mentioned = set(re.findall(r"`(sprintable_[a-z_]+)`", out))
    assert mentioned  # 뭔가는 언급됨
    assert mentioned <= set(ALL_TOOL_NAMES), f"invented tool names: {mentioned - set(ALL_TOOL_NAMES)}"


def test_compose_prompt_tool_cheat_sheet_excludes_ungranted_groups():
    """frontend(stories/tasks/chat/docs)만 준 role 은 epics/sprints 전용 도구를 언급하면 안 됨."""
    role = _role(default_tool_groups=["stories", "tasks", "chat", "docs"])
    out = compose_prompt(role, _RECIPE, "claude-code")
    assert "sprintable_add_epic" not in out
    assert "sprintable_create_sprint" not in out
    assert "sprintable_add_story" in out  # stories 그룹은 포함


def test_compose_prompt_always_allowed_tools_present_regardless_of_groups():
    """core(_ALWAYS_ALLOWED) 도구는 role 의 default_tool_groups 와 무관하게 항상 치트시트에 존재."""
    role = _role(default_tool_groups=["stories"])
    out = compose_prompt(role, _RECIPE, "claude-code")
    assert "sprintable_get_workflow_guide" in out
    assert "sprintable_ping" in out


def test_compose_prompt_raises_on_unknown_default_tool_group():
    role = _role(default_tool_groups=["stories", "typo-group"])
    with pytest.raises(ValueError, match="unknown group"):
        compose_prompt(role, _RECIPE, "claude-code")


# ── 실 S1 seed 데이터 전수 검증(회귀 가드 — "seed 지점" 검증) ─────────────────
_MIGRATION = Path(__file__).parent.parent / "alembic" / "versions" / "0156_role_templates.py"


def _load_s1_migration():
    spec = importlib.util.spec_from_file_location("rev_0156_s2check", _MIGRATION)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_all_s1_seeded_roles_default_tool_groups_are_valid_vocabulary():
    """S1 이 실제로 심은 4직무 seed 의 default_tool_groups 전부가 ALL_GROUPS 안에 있는지 —
    S1 자체 테스트는 exclusion(denylist)만 확인했었다·이건 전체 vocabulary 소속을 확인(더 엄격)."""
    mod = _load_s1_migration()
    for slug, _name, _category, _description, tool_groups, _recipe in mod._SEED:
        validate_tool_groups(tool_groups)  # 예외 없어야 함


def test_all_s1_seeded_roles_compose_without_error():
    """4직무 seed 전부가 실제로 compose_prompt 를 통과해 유효한 결과를 내는지(통합 스모크)."""
    mod = _load_s1_migration()
    for slug, name, _category, _description, tool_groups, _recipe_slug in mod._SEED:
        role = _role(
            name=name,
            role_behaviors=mod._ROLE_BEHAVIORS[slug],
            default_tool_groups=tool_groups,
        )
        out = compose_prompt(role, None, "claude-code")
        mentioned = set(re.findall(r"`(sprintable_[a-z_]+)`", out))
        assert mentioned <= set(ALL_TOOL_NAMES), (
            f"{slug}: invented tool names {mentioned - set(ALL_TOOL_NAMES)}"
        )
