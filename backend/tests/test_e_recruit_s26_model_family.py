"""E-RECRUIT S26 (story `510a1ed4`): `model_family.render_kit_for_family` — 후처리 렌더.

compose_kit(locale=content 선택)은 건드리지 않는다 — 이 테스트들은 compose_kit이 반환한 kit
dict를 입력으로만 쓰고, family 렌더 축(컨테이너/스타일)만 검증한다. 순수 함수 — I/O 0.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services.agent_recruiter import compose_kit
from app.services.model_family import (
    ModelFamily,
    render_kit_for_family,
    resolve_model_family,
)


def _role(**overrides) -> SimpleNamespace:
    defaults = dict(
        name="Backend Engineer",
        role_behaviors="당신은 백엔드 엔지니어입니다. You MUST always verify before done.",
        default_tool_groups=["stories", "tasks", "chat", "docs"],
        runtime_overrides={},
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


# --- resolve_model_family: runtime → family 매핑 + fail-safe -----------------------


@pytest.mark.parametrize(
    "runtime,expected",
    [
        ("claude-code", ModelFamily.CLAUDE),
        ("codex", ModelFamily.GPT),
        ("gemini", ModelFamily.GEMINI),
    ],
)
def test_resolve_model_family_explicit_mapping(runtime, expected):
    assert resolve_model_family(runtime) == expected


@pytest.mark.parametrize(
    "runtime", ["cursor", "grok", "opencode", "openclaw", "hermes", "pi"]
)
def test_resolve_model_family_generic_fallback_for_ambiguous_runtimes(runtime):
    # cursor(유저-모델선택)·grok(SSOT 미커버 4th family)·나머지 4(모델-무관 프레임워크) 전부
    # 순수 파생 불가라 GENERIC 폴백(디디 실측 근거).
    assert resolve_model_family(runtime) == ModelFamily.GENERIC


def test_resolve_model_family_none_and_unknown_never_crash():
    assert resolve_model_family(None) == ModelFamily.GENERIC
    assert resolve_model_family("") == ModelFamily.GENERIC
    assert resolve_model_family("totally-made-up-runtime") == ModelFamily.GENERIC


# --- render_kit_for_family: family별 컨테이너/스타일 ---------------------------------


def test_claude_wraps_each_section_in_matching_xml_tag():
    # 이 role_behaviors 는 forceful-emphasis 단어가 없어(_role() 기본값과 별개) wrap 외
    # 콘텐츠 자체가 그대로 보존되는지만 순수하게 검증한다(softening 은 별도 테스트가 커버).
    kit = compose_kit(_role(role_behaviors="당신은 백엔드 엔지니어입니다."), runtime="claude-code")
    rendered = render_kit_for_family(kit, ModelFamily.CLAUDE)
    for key, value in rendered.items():
        assert value.startswith(f"<{key}>\n")
        assert value.endswith(f"\n</{key}>")
        assert kit[key] in value  # 원본 콘텐츠 보존(재작성 없음, wrap만)


def test_claude_softens_forceful_emphasis():
    kit = {"role_context": "You MUST verify. This is CRITICAL. ALWAYS check. NEVER skip."}
    rendered = render_kit_for_family(kit, ModelFamily.CLAUDE)
    assert "MUST" not in rendered["role_context"]
    assert "CRITICAL" not in rendered["role_context"]
    assert "should" in rendered["role_context"]
    assert "important" in rendered["role_context"]


def test_claude_emphasis_softening_is_noop_when_no_forceful_words_present():
    kit = {"role_context": "그냥 평범한 한글 콘텐츠입니다."}
    rendered = render_kit_for_family(kit, ModelFamily.CLAUDE)
    assert "그냥 평범한 한글 콘텐츠입니다." in rendered["role_context"]


def test_gpt_prepends_markdown_section_title_without_xml():
    kit = compose_kit(_role(), runtime="codex")
    rendered = render_kit_for_family(kit, ModelFamily.GPT)
    assert rendered["role_context"].startswith("# Role & Objective\n\n")
    assert "<role_context>" not in rendered["role_context"]
    assert kit["role_context"] in rendered["role_context"]


def test_gpt_does_not_soften_forceful_emphasis():
    # SSOT: forceful language 는 GPT 에 무해 — Claude 전용 변환이 GPT 에 새지 않아야 하는.
    kit = {"role_context": "You MUST verify."}
    rendered = render_kit_for_family(kit, ModelFamily.GPT)
    assert "MUST" in rendered["role_context"]


def test_gemini_and_generic_pass_through_without_wrapping():
    kit = compose_kit(_role(), runtime="gemini")
    for family in (ModelFamily.GEMINI, ModelFamily.GENERIC):
        rendered = render_kit_for_family(kit, family)
        assert rendered["role_context"] == kit["role_context"]
        assert "<role_context>" not in rendered["onboarding"]
        assert not rendered["onboarding"].startswith("# ")


@pytest.mark.parametrize("locale", ["ko", "en"])
def test_gemini_reframes_known_negative_phrasing_in_onboarding_and_integration(locale):
    kit = compose_kit(_role(), runtime="gemini", locale=locale)
    rendered = render_kit_for_family(kit, ModelFamily.GEMINI)
    # 코드 소유 고정 문구(도구 치트시트 footer·integration prompt)의 blanket negative 는
    # 사라지고 scoped positive 로 재구성돼야 하는.
    forbidden = "지어내지 마세요" if locale == "ko" else "Don't invent"
    assert forbidden not in rendered["onboarding"]
    assert forbidden not in rendered["integration_prompt"]


def test_role_context_db_content_is_not_touched_by_negative_reframe():
    # role_context 는 DB 유래(role_behaviors) 라 negative-reframe 사전 매핑을 적용하지 않는다
    # (한글 부정문 자동치환 오번역 위험 — 디디 판단, 모듈 docstring 근거).
    kit = {"role_context": "하지 마세요 이건 우리 매핑에 없는 임의 DB 문구입니다."}
    rendered = render_kit_for_family(kit, ModelFamily.GEMINI)
    assert rendered["role_context"] == kit["role_context"]


def test_render_kit_for_family_accepts_plain_string_family_value():
    kit = {"role_context": "x"}
    assert render_kit_for_family(kit, "claude") == render_kit_for_family(kit, ModelFamily.CLAUDE)


def test_render_kit_for_family_falls_back_to_generic_on_unrecognized_family_string():
    kit = {"role_context": "You MUST verify."}
    rendered = render_kit_for_family(kit, "not-a-real-family")
    # generic 렌더(무래핑)와 동일해야 하는 — 크래시 없이 가장 무난한 폴백.
    assert rendered == render_kit_for_family(kit, ModelFamily.GENERIC)


def test_original_kit_dict_is_not_mutated():
    kit = compose_kit(_role(), runtime="claude-code")
    original = dict(kit)
    render_kit_for_family(kit, ModelFamily.CLAUDE)
    assert kit == original


@pytest.mark.parametrize("family", list(ModelFamily))
def test_same_role_renders_differently_or_identically_per_family_but_never_crashes(family):
    # [실증] AC4 축소판(단위테스트 레벨) — 4 family 모두 크래시 0·항상 dict 반환.
    kit = compose_kit(_role(), runtime="claude-code", locale="ko")
    rendered = render_kit_for_family(kit, family)
    assert isinstance(rendered, dict)
    assert set(rendered.keys()) == set(kit.keys())


def test_claude_and_gpt_and_generic_produce_visibly_distinct_containers():
    kit = compose_kit(_role(), runtime="claude-code")
    claude = render_kit_for_family(kit, ModelFamily.CLAUDE)["role_context"]
    gpt = render_kit_for_family(kit, ModelFamily.GPT)["role_context"]
    generic = render_kit_for_family(kit, ModelFamily.GENERIC)["role_context"]
    assert claude != gpt != generic
    assert claude.startswith("<role_context>")
    assert gpt.startswith("# Role & Objective")
    assert generic == kit["role_context"]
