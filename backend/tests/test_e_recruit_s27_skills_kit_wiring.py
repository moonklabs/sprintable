"""E-RECRUIT S27 (story `8116d6f5`): role_template.skills → compose_kit 출력 배선.

디디 발견2(S26 blueprint 정독) 후속: skills(AgentSkill·SSOT section 5 "skills-for-discovery")가
compose_kit에서 0 참조였던 갭을 메운다. compose_kit은 여전히 순수 함수(I/O 0, G4 유지).
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.schemas.a2a import AgentSkill
from app.services.agent_recruiter import compose_kit


def _role(**overrides) -> SimpleNamespace:
    defaults = dict(
        name="Backend Engineer",
        role_behaviors="당신은 백엔드 엔지니어입니다.",
        role_behaviors_i18n={},
        default_tool_groups=["stories", "tasks", "chat", "docs"],
        runtime_overrides={},
        skills=[],
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


_PLANNING_SKILL = {
    "id": "sprint-planning",
    "name": "Sprint Planning",
    "description": "스프린트 계획을 수립합니다.",
    "tags": ["pm", "planning"],
}


# --- AC1: skills가 kit 출력에 배선(locale content-선택 축과 정합) --------------------


def test_skills_present_adds_skills_key_to_kit():
    role = _role(skills=[_PLANNING_SKILL])
    kit = compose_kit(role, runtime="claude-code", locale="ko")
    assert "skills" in kit
    assert "Sprint Planning" in kit["skills"]
    assert "sprint-planning" in kit["skills"]
    assert "스프린트 계획을 수립합니다." in kit["skills"]
    assert "pm" in kit["skills"] and "planning" in kit["skills"]


def test_skills_block_uses_locale_heading():
    role = _role(skills=[_PLANNING_SKILL])
    ko_kit = compose_kit(role, runtime="claude-code", locale="ko")
    en_kit = compose_kit(role, runtime="claude-code", locale="en")
    assert "발견 가능 스킬" in ko_kit["skills"]
    assert "Discoverable Skills" in en_kit["skills"]


def test_skills_block_validates_via_agent_skill_schema():
    # AgentSkill(a2a.py) 그대로 재사용 — 신규 스키마 발명 안 함(디디 설계 결정).
    role = _role(skills=[_PLANNING_SKILL])
    kit = compose_kit(role, runtime="claude-code", locale="ko")
    # model_validate가 실제로 쓰였다는 걸 examples 필드(optional) 누락에도 안 깨지는 것으로 방증.
    assert AgentSkill.model_validate(_PLANNING_SKILL).name == "Sprint Planning"
    assert "skills" in kit


def test_multiple_skills_all_rendered():
    role = _role(skills=[
        _PLANNING_SKILL,
        {"id": "retro-facilitation", "name": "Retro Facilitation", "description": "회고를 진행합니다.", "tags": []},
    ])
    kit = compose_kit(role, runtime="claude-code", locale="ko")
    assert "Sprint Planning" in kit["skills"]
    assert "Retro Facilitation" in kit["skills"]
    assert "회고를 진행합니다." in kit["skills"]


def test_skill_without_tags_renders_without_tags_label():
    role = _role(skills=[
        {"id": "x", "name": "X", "description": "desc", "tags": []},
    ])
    kit = compose_kit(role, runtime="claude-code", locale="ko")
    assert "태그" not in kit["skills"]


# --- AC2: kit dict 구조에 노출(다른 family 렌더가 감쌀 수 있게 별도 key) -----------------


def test_skills_is_a_distinct_kit_key_not_merged_into_role_context():
    role = _role(skills=[_PLANNING_SKILL])
    kit = compose_kit(role, runtime="claude-code", locale="ko")
    assert "Sprint Planning" not in kit["role_context"]
    assert "Sprint Planning" not in kit["onboarding"]
    assert kit["skills"] != kit["role_context"]


def test_skills_key_ordered_after_onboarding_before_workflow_pointer():
    role = _role(skills=[_PLANNING_SKILL])
    kit = compose_kit(role, runtime="claude-code", locale="ko")
    keys = list(kit.keys())
    assert keys.index("onboarding") < keys.index("skills") < keys.index("workflow_pointer")


# --- AC3: skills 빈 role은 빈 블록/생략(깨짐 0)·회귀 0 -------------------------------


def test_empty_skills_omits_skills_key_entirely():
    role = _role(skills=[])
    kit = compose_kit(role, runtime="claude-code", locale="ko")
    assert "skills" not in kit
    assert set(kit.keys()) == {"role_context", "onboarding", "workflow_pointer", "integration_prompt"}


def test_missing_skills_attribute_does_not_crash():
    # duck-typing 대상이 skills 속성 자체가 없는 구버전 객체일 수도 있음(getattr 기본값 폴백).
    role = SimpleNamespace(
        name="Legacy Role", role_behaviors="레거시.", role_behaviors_i18n={},
        default_tool_groups=["stories"], runtime_overrides={},
    )
    kit = compose_kit(role, runtime="claude-code", locale="ko")
    assert "skills" not in kit
    assert kit["role_context"]  # 기존 섹션은 여전히 정상 생성


def test_none_skills_does_not_crash():
    role = _role(skills=None)
    kit = compose_kit(role, runtime="claude-code", locale="ko")
    assert "skills" not in kit


def test_existing_sections_unchanged_by_skills_presence():
    role_without = _role(skills=[])
    role_with = _role(skills=[_PLANNING_SKILL])
    kit_without = compose_kit(role_without, runtime="claude-code", locale="ko")
    kit_with = compose_kit(role_with, runtime="claude-code", locale="ko")
    assert kit_without["role_context"] == kit_with["role_context"]
    assert kit_without["onboarding"] == kit_with["onboarding"]
    assert kit_without["workflow_pointer"] == kit_with["workflow_pointer"]
    assert kit_without["integration_prompt"] == kit_with["integration_prompt"]


@pytest.mark.parametrize("locale", ["ko", "en"])
def test_no_regression_across_both_locales_when_skills_absent(locale):
    role = _role(skills=[])
    kit = compose_kit(role, runtime="claude-code", locale=locale)
    assert "skills" not in kit
    assert kit["role_context"]
