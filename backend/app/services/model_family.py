"""E-RECRUIT S26 (story `510a1ed4`): model-family 후처리 렌더 — "진짜 intelligence" 축.

리서치 SSOT: doc `model-aware-prompt-composer-design`(PO 오르테가 2026-07-09) §5(브랜칭 룰) +
§cross-cutting(delimiter idiom·emphasis normalization·negative→scoped-positive).

설계 결정(blueprint 합의, ①~④):
- **compose_kit(agent_recruiter.py)은 손대지 않는다** — locale=content 선택(순수 합성·G4)과
  family=스타일 렌더는 별개 축. 이 모듈의 ``render_kit_for_family``가 compose_kit이 반환한
  kit dict를 받아 스타일만 입히는 **후처리**다(SSOT §5 cross-cutting rule 3: family당 renderer 1개).
- **runtime→family 매핑은 순수 파생이 안 된다** — 9개 RuntimeType 중 3개(claude-code/codex/
  gemini)만 family가 명확하고, 나머지(cursor=유저가 모델 직접 선택하는 멀티모델 IDE·grok=SSOT
  미커버 4th family·opencode/openclaw/hermes/pi=모델-무관 범용 프레임워크)는 슬러그만으론 확정
  불가 — 전부 ``GENERIC``(Gemini의 terse+consistent-delimiter 스타일, SSOT 근거 중 가장 무난한
  최소공배수)로 폴백한다. cursor 등의 명시적 override(recruit 시점 파라미터)는 후속.
- **role_behaviors는 SSOT가 가정하는 "5개 named section" 구조화 데이터가 아니다** — 실측(디디,
  S23 enrich 실 payload 확인)상 `##` 헤더 텍스트·개수가 role마다 제각각인 자유 markdown blob.
  섹션별 XML 태그 분리(`<identity>`,`<quality_gates>` 등)는 role_behaviors 저작 스키마가
  구조화되는 후속 트랙 — 이 스토리는 **통짜 1섹션 wrap MVP**(kit dict의 4개 key 각각을 하나의
  단위로 렌더)만 한다.

이 모듈도 compose_kit과 동일하게 **결정론적**이다 — LLM 호출·네트워크·DB 접근 0. 정규식 기반
치환만 하므로 입력에 매치되는 패턴이 없으면 있는 그대로 통과한다(no-op은 실패가 아니다).
"""
from __future__ import annotations

import re
from enum import Enum

# --- 1. runtime → family 매핑 (§2 blueprint 합의) -----------------------------------


class ModelFamily(str, Enum):
    """SSOT가 브랜칭 룰을 제공하는 3개 family + 미상/모델-무관 런타임용 안전 폴백 1개."""

    CLAUDE = "claude"
    GPT = "gpt"
    GEMINI = "gemini"
    GENERIC = "generic"  # SSOT 미커버 또는 모델-무관 런타임의 fail-safe 기본값.


# 의도적으로 RuntimeType(agent_runtime.py, E-CHAT-CMD SSOT — deterministic-command 축)을
# 재사용하지 않는다 — compose_kit이 이미 runtime을 plain str로 받는 기존 관례(agent_recruiter.py·
# MCP_NATIVE_RUNTIMES와 동형)를 따른다. RuntimeType은 이 axis(model family)와 무관한 별개 축.
_RUNTIME_TO_FAMILY: dict[str, ModelFamily] = {
    "claude-code": ModelFamily.CLAUDE,
    "codex": ModelFamily.GPT,
    "gemini": ModelFamily.GEMINI,
    # 나머지 6개(cursor/grok/opencode/openclaw/hermes/pi)는 매핑에 없음 — 아래 resolve_model_family
    # 의 미등록-런타임 분기가 GENERIC으로 fail-safe 처리한다(register 안 해도 안전).
}


def resolve_model_family(runtime: str | None) -> ModelFamily:
    """runtime → family. None/빈값/미등록 런타임은 전부 GENERIC(크래시 0·resolve_locale과 동일
    fail-safe 철학 — 미지원 값을 보수적 기본값으로 폴백, 예외를 던지지 않는다)."""
    if not runtime:
        return ModelFamily.GENERIC
    return _RUNTIME_TO_FAMILY.get(runtime, ModelFamily.GENERIC)


# --- 2. family별 통짜 wrap 렌더 (§3 blueprint 합의) ---------------------------------

_KIT_SECTION_TITLES_GPT: dict[str, str] = {
    "role_context": "# Role & Objective",
    "onboarding": "# Instructions & Tools",
    "workflow_pointer": "# Workflow",
    "integration_prompt": "# Integration Notes",
}

# Claude 렌더 대상 emphasis 패턴 — SSOT 1d("과포싱 언어가 over-triggering") 근거. 현재 코드
# 상수(_AGILE_OPERATING_RULES 등)엔 리터럴 매치가 없다(한글 콘텐츠라 ALL-CAPS 자체가 안 씀) —
# 이 변환은 향후 role_behaviors(DB, 영어 혼용 가능)에 대비한 정직한 best-effort. 매치가 없으면
# no-op(실패 아님) — 단위테스트로 매치 有/無 둘 다 검증.
_FORCEFUL_EMPHASIS_PATTERN = re.compile(r"\b(MUST|CRITICAL|ALWAYS|NEVER)\b")
_FORCEFUL_EMPHASIS_SOFTENED: dict[str, str] = {
    "MUST": "should",
    "CRITICAL": "important",
    "ALWAYS": "typically",
    "NEVER": "avoid",
}


def _soften_forceful_emphasis(text: str) -> str:
    """Claude 전용 — ALL-CAPS MUST/CRITICAL/ALWAYS/NEVER를 완곡 표현으로(SSOT 1d)."""
    return _FORCEFUL_EMPHASIS_PATTERN.sub(
        lambda m: _FORCEFUL_EMPHASIS_SOFTENED[m.group(0)], text
    )


# Gemini/generic 전용 — negative→scoped-positive(SSOT 3d). role_behaviors(DB, 임의 문구)까지
# 일반화해 치환하는 건 안전하지 않다(한글 부정문 → 긍정문 자동변환은 오번역 위험) — **우리가
# 소유한 고정 코드 상수(agent_recruiter.py의 onboarding/integration_prompt 텍스트)에 한해서만**
# 정확한 사전 매핑을 적용한다. role_context(DB 유래) 는 대상에서 명시적으로 제외.
_NEGATIVE_REFRAME_MAP: dict[str, str] = {
    "위 목록에 없는 도구 이름을 지어내지 마세요 — 확실하지 않으면 "
    "`sprintable_get_workflow_guide`로 먼저 확인하세요.": (
        "위 목록에 있는 도구 이름만 사용하세요 — 확실하지 않으면 "
        "`sprintable_get_workflow_guide`로 먼저 확인하세요."
    ),
    "Don't invent tool names that aren't in the list above — if you're "
    "not sure, check `sprintable_get_workflow_guide` first.": (
        "Only use tool names from the list above — if you're not sure, "
        "check `sprintable_get_workflow_guide` first."
    ),
    "이 파일 내용을 그대로 복사해 자신을 덮어쓰지 마세요": "이 파일 내용을 당신 언어로 바꿔 담으세요",
    "don't copy this file verbatim over\nyourself": "put it in your own words",
    "**기존 정체성을 덮지 말고, 당신 방식대로 자기화하세요.**": (
        "**기존 정체성을 유지한 채, 당신 방식대로 자기화하세요.**"
    ),
    "**Don't overwrite your existing identity — integrate this in your own way.**": (
        "**Keep your existing identity intact — integrate this in your own way.**"
    ),
    "워크플로는 고정 절차로 외우지 말고, 매번 `sprintable_get_workflow_guide`로 최신 확인": (
        "워크플로는 매번 `sprintable_get_workflow_guide`로 최신 확인"
    ),
    "Don't memorize the workflow as a fixed procedure — re-check it every time via\n  "
    "`sprintable_get_workflow_guide`": (
        "Re-check the workflow every time via\n  `sprintable_get_workflow_guide`"
    ),
}


def _reframe_known_negatives(text: str) -> str:
    """Gemini/generic 전용 — 우리가 소유한 고정 문구만 정확 치환(사전 기반, no-op 안전)."""
    for negative, positive in _NEGATIVE_REFRAME_MAP.items():
        text = text.replace(negative, positive)
    return text


def _render_claude(kit: dict[str, str]) -> dict[str, str]:
    """XML-native 컨테이너(SSOT 1a) + emphasis softening(SSOT 1d)."""
    return {
        key: f"<{key}>\n{_soften_forceful_emphasis(value)}\n</{key}>"
        for key, value in kit.items()
    }


def _render_gpt(kit: dict[str, str]) -> dict[str, str]:
    """Markdown 헤더 컨테이너(SSOT 2a/2b — GPT는 markdown 선호, forceful 언어 무해)."""
    return {
        key: f"{_KIT_SECTION_TITLES_GPT.get(key, f'# {key}')}\n\n{value}"
        for key, value in kit.items()
    }


def _render_gemini_or_generic(kit: dict[str, str]) -> dict[str, str]:
    """무-래핑 terse(SSOT 3e — 가장 짧은 프롬프트가 최적화 자체) + negative reframe(SSOT 3d)."""
    return {key: _reframe_known_negatives(value) for key, value in kit.items()}


_RENDERERS = {
    ModelFamily.CLAUDE: _render_claude,
    ModelFamily.GPT: _render_gpt,
    ModelFamily.GEMINI: _render_gemini_or_generic,
    ModelFamily.GENERIC: _render_gemini_or_generic,
}


def render_kit_for_family(kit: dict[str, str], family: ModelFamily | str) -> dict[str, str]:
    """compose_kit이 반환한 kit dict에 family별 컨테이너/스타일을 입히는 순수 후처리 함수.

    compose_kit 자체는 건드리지 않는다(G4 계약 보존) — locale=content 선택은 compose_kit이
    이미 끝낸 뒤, 이 함수가 family=스타일 렌더만 얹는다. 두 축은 독립이라 호출 순서 고정
    (locale 먼저 compose_kit, family 그다음 이 함수) 외엔 서로 간섭하지 않는다.

    Args:
        kit: ``compose_kit()`` 반환 dict — ``{role_context, onboarding, workflow_pointer,
            integration_prompt}``. 임의 키 구성도 동작(dict.items() 순회라 스키마 고정 아님).
        family: ``ModelFamily`` 또는 그 값(str). 미인식 문자열은 GENERIC으로 fail-safe
            (``resolve_model_family``와 동일 철학 — 크래시 대신 가장 무난한 폴백).

    Returns:
        같은 키 구조의 새 dict — family 스타일이 입혀진 값. 원본 kit dict는 불변(순수 함수).
    """
    try:
        resolved = family if isinstance(family, ModelFamily) else ModelFamily(family)
    except ValueError:
        resolved = ModelFamily.GENERIC
    renderer = _RENDERERS[resolved]
    return renderer(kit)
