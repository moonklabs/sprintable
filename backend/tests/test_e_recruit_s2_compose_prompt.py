"""E-RECRUIT S2 (story 58c37f17): `agent_recruiter.compose_kit` — deterministic composer.

G3(단일 소스): onboarding 파트의 도구 치트시트는 role_template.default_tool_groups →
mcp_toolset.tool_group() SSOT로만 파생(하드코딩 별도 목록 금지). G4(배달 분리): compose_kit는
순수 합성만(네트워크/DB 호출 0) — 이 테스트들은 전부 인자만으로 호출하고 어떤 I/O 도 mock 하지
않는다(진짜 순수함 증명). QA MINOR 하드닝: role_template.default_tool_groups 값이 실제 그룹
vocabulary 밖이면 fail-closed(resolve_policy 자체의 fail-open 은 S3 스코프 — 여긴 손대지 않는다).

채용-kit 재설계(story b1fe41cf, 문서 `recruit-output-kit-redesign-crux`, 선생님 GO
2026-07-08) — 옛 `compose_prompt`(단일 문자열, CLAUDE.md 전체 대체 노림)를 `compose_kit`
(구조화 dict: role_context/onboarding/workflow_pointer/integration_prompt)으로 대체했다.
recipe DATA(steps 등)는 더 이상 kit 합성 인자가 아니다(워크플로=유저것, 크럭스 결정①).
"""
from __future__ import annotations

import importlib.util
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.services.agent_recruiter import compose_kit, validate_tool_groups
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


def _joined(kit: dict[str, str]) -> str:
    return "\n\n".join(kit.values())


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


# ── compose_kit — 순수성 + 결정론 ──────────────────────────────────────────
def test_compose_kit_is_deterministic_same_input_same_output():
    """diffable — 동일 입력 두 번 호출 결과가 문자 그대로 동일(LLM 비호출 증명)."""
    role = _role()
    out1 = compose_kit(role, "claude-code")
    out2 = compose_kit(role, "claude-code")
    assert out1 == out2


def test_compose_kit_returns_four_parts():
    role = _role()
    kit = compose_kit(role, "claude-code")
    assert set(kit.keys()) == {"role_context", "onboarding", "workflow_pointer", "integration_prompt"}
    assert "Sprintable 역할 컨텍스트" in kit["role_context"]  # role_context([A])
    assert "사용 가능 도구 (치트시트)" in kit["onboarding"]  # onboarding([C])
    assert "애자일 자율 운영 룰" in kit["onboarding"]  # onboarding([D])
    assert "런타임 노트" in kit["onboarding"]  # onboarding([E])
    assert "Sprintable 워크플로" in kit["workflow_pointer"]  # workflow_pointer([B])


def test_compose_kit_role_context_includes_role_behaviors_verbatim():
    role = _role(role_behaviors="스스로 판단해 claim하고 소통하세요.")
    kit = compose_kit(role, "claude-code")
    assert "스스로 판단해 claim하고 소통하세요." in kit["role_context"]


# ── E-I18N EN 콘텐츠(story d6e3f407) — role_context 데이터 i18n 소비 배선 ──────────

def test_compose_kit_role_context_falls_back_to_ko_when_role_behaviors_i18n_missing():
    """role_behaviors_i18n 미설정(SimpleNamespace에 속성 자체 없음) — getattr 방어로 ko 그대로.
    오늘 실 DB 상태(모든 role_templates.role_behaviors_i18n={})와 동형 — 무회귀 확인."""
    role = _role(role_behaviors="스스로 판단해 claim하고 소통하세요.")
    kit = compose_kit(role, "claude-code", locale="en")
    assert "스스로 판단해 claim하고 소통하세요." in kit["role_context"]


def test_compose_kit_role_context_falls_back_to_ko_when_en_key_empty():
    role = _role(role_behaviors="한글 원문.", role_behaviors_i18n={})
    kit = compose_kit(role, "claude-code", locale="en")
    assert "한글 원문." in kit["role_context"]


def test_compose_kit_role_context_uses_i18n_when_present():
    role = _role(
        role_behaviors="한글 원문.",
        role_behaviors_i18n={"en": "You are a backend engineer, natively authored."},
    )
    kit = compose_kit(role, "claude-code", locale="en")
    assert "You are a backend engineer, natively authored." in kit["role_context"]
    assert "한글 원문." not in kit["role_context"]


def test_compose_kit_role_context_ko_locale_uses_legacy_column_when_overlay_has_no_ko_key():
    """locale="ko"인데 overlay엔 "en"만 있으면(오늘 생성 파이프라인이 실제로 채울 유일한 키)
    레거시 ko 컬럼 그대로(캐논 소스) — overlay는 "en" 전용이라는 문서화된 설계와 정합."""
    role = _role(
        role_behaviors="한글 원문.",
        role_behaviors_i18n={"en": "English content"},
    )
    kit = compose_kit(role, "claude-code", locale="ko")
    assert "한글 원문." in kit["role_context"]


def test_compose_kit_workflow_pointer_never_hardcodes_recipe_content():
    """크럭스 결정①: 워크플로는 유저것 — recipe DATA를 kit에 하드코딩하지 않는다. compose_kit는
    이제 recipe 인자 자체를 받지 않으므로(구조적으로 보장) workflow_pointer는 항상 동일한
    자가-pull 유도 텍스트만 담는다(recipe 유무·내용과 무관)."""
    role = _role()
    kit = compose_kit(role, "claude-code")
    assert "sprintable_get_workflow_guide" in kit["workflow_pointer"]


def test_compose_kit_includes_runtime_identifier():
    role = _role()
    kit = compose_kit(role, "cursor")
    assert "`cursor`" in kit["onboarding"]


def test_compose_kit_includes_runtime_override_when_present():
    role = _role(runtime_overrides={"claude-code": "CLAUDE.md 에 이 지침을 저장하세요."})
    kit = compose_kit(role, "claude-code")
    assert "CLAUDE.md 에 이 지침을 저장하세요." in kit["onboarding"]


def test_compose_kit_integration_prompt_warns_against_overwriting_existing_identity():
    """선생님 결정③(2026-07-08): kit 말미 자기통합/메모리 유도 — 기존 정체성을 덮지 말라는
    경고가 명시적으로 있어야 한다(정적 주입이 아니라 스스로 판단해 반영하라는 유도)."""
    role = _role()
    kit = compose_kit(role, "claude-code")
    assert "기존 정체성을 덮지" in kit["integration_prompt"]
    assert "sprintable_get_workflow_guide" in kit["integration_prompt"]


# ── 까심 QA 후속(story 6f6ac081, 2026-07-08): 런타임 노트가 커넥터-라우팅 런타임에도 정직해야 함 ──
def test_compose_kit_mcp_native_runtime_says_no_setup_needed():
    role = _role()
    kit = compose_kit(role, "claude-code")
    assert "별도 설정이 필요 없습니다" in kit["onboarding"]
    assert "SSE 커넥터" not in kit["onboarding"]


def test_compose_kit_connector_only_runtime_gives_honest_setup_instructions():
    """전에는 grok/pi/hermes/openclaw/opencode 도 "별도 설정 불요"라는 거짓 안내를 받았다(까심
    `compose_prompt(runtime="grok")` 재현) — mcp_config=None인 커넥터-라우팅 런타임은 실제로
    connectors/{runtime}-sprintable/ 복사 + AGENT_API_KEY 설정 + 어댑터 실행이 필요하다."""
    role = _role()
    kit = compose_kit(role, "grok")
    assert "별도 설정이 필요 없습니다" not in kit["onboarding"]
    assert "SSE 커넥터" in kit["onboarding"]
    assert "connectors/grok-sprintable/" in kit["onboarding"]
    assert "AGENT_API_KEY" in kit["onboarding"]


def test_compose_kit_generic_connector_bucket_also_honest():
    role = _role()
    kit = compose_kit(role, "connector")
    assert "별도 설정이 필요 없습니다" not in kit["onboarding"]
    assert "SSE 커넥터" in kit["onboarding"]


# ── E-I18N Phase A(story 11f1087c, PO GO 2026-07-08) — 코드 상수 locale 분기 ────────

def test_compose_kit_default_locale_is_korean_backward_compatible():
    """locale 인자를 안 주면 정확히 예전과 동일한 한글 출력."""
    role = _role()
    out = _joined(compose_kit(role, "claude-code"))
    assert "## 애자일 자율 운영 룰" in out
    assert "## Sprintable 워크플로" in out
    assert "## 사용 가능 도구 (치트시트)" in out
    assert "## Agile Autonomous Operating Rules" not in out


def test_compose_kit_english_locale_localizes_all_parts():
    """role_context 래퍼(헤더)/onboarding/workflow_pointer/integration_prompt 전부 영어로
    나오되, role_context 내부의 role_behaviors(DATA)는 아직 한글 그대로(Phase A 스코프 —
    데이터 i18n은 Phase B/후속, 의도적)."""
    role = _role(role_behaviors="스스로 판단해 claim하고 소통하세요.")
    kit = compose_kit(role, "claude-code", locale="en")
    out = _joined(kit)
    assert "## Agile Autonomous Operating Rules" in out
    assert "## Sprintable Workflow" in out
    assert "## Available Tools (Cheat Sheet)" in out
    assert "## Runtime Notes" in out
    assert "MCP connection/scope was already configured" in out
    assert "## 애자일 자율 운영 룰" not in out
    # role_context 헤더는 번역, role_behaviors(DATA) 자체는 의도적으로 미번역(Phase A 스코프 밖)
    assert "스스로 판단해 claim하고 소통하세요." in kit["role_context"]
    assert "# Backend Engineer — Sprintable Role Context" in kit["role_context"]
    # integration_prompt도 locale 분기
    assert "Don't overwrite your existing identity" in kit["integration_prompt"]
    assert "기존 정체성을 덮지" not in kit["integration_prompt"]


def test_compose_kit_english_connector_runtime_localized():
    role = _role()
    kit = compose_kit(role, "grok", locale="en")
    assert "no separate setup is needed" not in kit["onboarding"]
    assert "SSE connector" in kit["onboarding"]
    assert "connectors/grok-sprintable/" in kit["onboarding"]
    assert "AGENT_API_KEY" in kit["onboarding"]


def test_compose_kit_tool_names_and_group_labels_stay_unlocalized_identifiers():
    """도구/그룹 이름은 실 레지스트리 식별자라 en/ko 무관하게 그대로 — 래퍼 텍스트만 번역."""
    role = _role(default_tool_groups=["stories", "tasks"])
    out_ko = _joined(compose_kit(role, "claude-code", locale="ko"))
    out_en = _joined(compose_kit(role, "claude-code", locale="en"))
    for out in (out_ko, out_en):
        assert "`sprintable_claim_story`" in out
        assert "**stories**:" in out


# ── G3: 도구 치트시트 = 단일 소스(ALL_TOOL_NAMES) 파생, 환각 0 ─────────────────
def test_compose_kit_tool_cheat_sheet_only_references_real_tool_names():
    role = _role(default_tool_groups=[
        "stories", "tasks", "epics", "sprints", "hypotheses", "chat", "docs",
        "analytics", "retro", "standup", "meetings", "notifications", "webhooks",
        "rewards", "audit", "agent_runs",
    ])
    out = compose_kit(role, "claude-code")["onboarding"]
    mentioned = set(re.findall(r"`(sprintable_[a-z_]+)`", out))
    assert mentioned  # 뭔가는 언급됨
    assert mentioned <= set(ALL_TOOL_NAMES), f"invented tool names: {mentioned - set(ALL_TOOL_NAMES)}"


def test_compose_kit_tool_cheat_sheet_excludes_ungranted_groups():
    """frontend(stories/tasks/chat/docs)만 준 role 은 epics/sprints 전용 도구를 언급하면 안 됨."""
    role = _role(default_tool_groups=["stories", "tasks", "chat", "docs"])
    out = compose_kit(role, "claude-code")["onboarding"]
    assert "sprintable_add_epic" not in out
    assert "sprintable_create_sprint" not in out
    assert "sprintable_add_story" in out  # stories 그룹은 포함


def test_compose_kit_always_allowed_tools_present_regardless_of_groups():
    """core(_ALWAYS_ALLOWED) 도구는 role 의 default_tool_groups 와 무관하게 항상 치트시트에 존재."""
    role = _role(default_tool_groups=["stories"])
    out = compose_kit(role, "claude-code")["onboarding"]
    assert "sprintable_get_workflow_guide" in out
    assert "sprintable_ping" in out


def test_compose_kit_raises_on_unknown_default_tool_group():
    role = _role(default_tool_groups=["stories", "typo-group"])
    with pytest.raises(ValueError, match="unknown group"):
        compose_kit(role, "claude-code")


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
    """4직무 seed 전부가 실제로 compose_kit 를 통과해 유효한 결과를 내는지(통합 스모크)."""
    mod = _load_s1_migration()
    for slug, name, _category, _description, tool_groups, _recipe_slug in mod._SEED:
        role = _role(
            name=name,
            role_behaviors=mod._ROLE_BEHAVIORS[slug],
            default_tool_groups=tool_groups,
        )
        out = compose_kit(role, "claude-code")["onboarding"]
        mentioned = set(re.findall(r"`(sprintable_[a-z_]+)`", out))
        assert mentioned <= set(ALL_TOOL_NAMES), (
            f"{slug}: invented tool names {mentioned - set(ALL_TOOL_NAMES)}"
        )
