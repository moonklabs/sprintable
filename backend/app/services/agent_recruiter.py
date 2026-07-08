"""E-RECRUIT S2 (story 58c37f17): 자율 운영 지침 합성 — deterministic composer.

블루프린트 §3 개정 방향(2026-07-04): "갖춰주고 → 자율 운영"(agentic). `compose_prompt`는
**결정론적 template-composition**만 한다(LLM 합성 아님) — role_template.role_behaviors·
workflow recipe·검증된 ALL_TOOL_NAMES·고정 애자일 룰·runtime 노트를 그대로 이어붙일 뿐, 새
텍스트를 생성/추론하지 않는다. 툴 이름을 지어낼 여지 자체가 없다(도구 치트시트는 실 레지스트리
에서 파생).

G4(설계 갭 반영): 이 함수는 **순수 합성만** 반환한다 — 네트워크/DB 호출 0, 부수효과 0.
런타임 배달(connection-artifact 번들 삽입 등)은 이 함수의 책임이 아니다(S5 공용 레이어).
"""
from __future__ import annotations

from typing import Any

from app.services.agent_onboarding_config import MCP_NATIVE_RUNTIMES, resolve_locale
from app.services.mcp_toolset import ALL_GROUPS, ALL_TOOL_NAMES, _ALWAYS_ALLOWED, tool_group

# E-I18N Phase A(story 11f1087c, 문서 `i18n-architecture-design-crux`, 선생님 GO 2026-07-08):
# 코드 상수([[no-pr-for-data]] 무관 — 데이터 아님)만 이번 페이즈에서 locale 분기한다. section
# [A](role_template.role_behaviors, DB 데이터)는 그대로 한글 — Phase B(스키마)+후속(번역 콘텐츠,
# 선생님 게이트) 이후. resolve_locale()로 미지원 locale은 항상 "ko"로 폴백(크래시 0).
_AGILE_OPERATING_RULES: dict[str, str] = {
    "ko": """## 애자일 자율 운영 룰

- **claim**: 작업을 시작하기 전에 반드시 claim 하세요. 이미 누군가 진행 중인 작업을 가로채지 마세요.
- **lock**: 같은 파일을 동시에 여러 에이전트가 건드릴 수 있는 작업이면 시작 전 잠그고, 끝나면 즉시 풉니다.
- **status**: 작업 시작·완료·블로커 발생 시점마다 상태를 갱신하세요. 상태가 실제 진행과 어긋나면 팀 전체가 헷갈립니다.
- **소통**: 막히거나 방향을 바꿨거나 완료했으면 침묵하지 말고 즉시 채팅으로 알리세요. 아무도 몰래 혼자 진행하지 마세요.
- **정직**: 실제로 확인/실행하지 않은 것을 완료로 보고하지 마세요. 근거(실행 결과·재현 절차)와 함께 보고하세요.
""",
    "en": """## Agile Autonomous Operating Rules

- **claim**: Always claim a task before starting it. Don't take over work someone else is already doing.
- **lock**: If multiple agents could touch the same file concurrently, lock it before starting and release it immediately when done.
- **status**: Update status when you start, finish, or hit a blocker. If status doesn't match real progress, the whole team gets confused.
- **communicate**: If you're blocked, changed direction, or finished, don't stay silent — say so immediately in chat. Don't work alone in secret.
- **honesty**: Don't report something as done unless you actually verified or ran it. Report with evidence (execution results, reproduction steps).
""",
}


def validate_tool_groups(groups: list[str]) -> None:
    """E-RECRUIT S2(QA G3 관련 하드닝): role_template.default_tool_groups 값이 실제 존재하는
    그룹 vocabulary(mcp_toolset.ALL_GROUPS) 안에 있는지 검증 — 소비 지점(compose_prompt) fail-closed.

    ⚠️ `resolve_policy`(mcp_toolset.py) 자체의 fail-open(미인식 그룹→전체 허용 폴백) 은 이 스토리의
    스코프가 아니다(S3 하드닝 대상·PO 확정) — 여긴 **synthesis 가 잘못된 그룹명으로 치트시트를
    조용히 비우거나 엉뚱하게 구성하는 것만** 막는다.
    """
    unknown = [g for g in groups if g not in ALL_GROUPS]
    if unknown:
        raise ValueError(
            f"role_template.default_tool_groups contains unknown group(s): {unknown} "
            f"(valid: {sorted(ALL_GROUPS)})"
        )


_TOOL_CHEAT_SHEET_TEXT: dict[str, dict[str, str]] = {
    "ko": {
        "heading": "## 사용 가능 도구 (치트시트)",
        "always_available": "**항상 사용 가능**:",
        "footer": (
            "\n위 목록에 없는 도구 이름을 지어내지 마세요 — 확실하지 않으면 "
            "`sprintable_get_workflow_guide`로 먼저 확인하세요."
        ),
    },
    "en": {
        "heading": "## Available Tools (Cheat Sheet)",
        "always_available": "**Always available**:",
        "footer": (
            "\nDon't invent tool names that aren't in the list above — if you're "
            "not sure, check `sprintable_get_workflow_guide` first."
        ),
    },
}


def _tool_cheat_sheet(tool_groups: list[str], locale: str = "ko") -> str:
    """[C] tool 치트시트 — 그룹→**실 등록 도구명**(ALL_TOOL_NAMES·tool_group() SSOT 파생. G3).

    core(_ALWAYS_ALLOWED) 도구는 role 무관 항상 포함 — 그 어떤 scope 로도 항상 허용되는 도구라
    치트시트에서 빠지면 존재를 모른 채 있는 것처럼 재발명할 위험이 있다. 도구/그룹 이름 자체는
    실 레지스트리 식별자라 번역 대상 아님(E-I18N Phase A) — 래퍼 텍스트만 locale 분기.
    """
    validate_tool_groups(tool_groups)
    text = _TOOL_CHEAT_SHEET_TEXT[locale]
    wanted = set(tool_groups)
    always_on = sorted(t for t in ALL_TOOL_NAMES if t in _ALWAYS_ALLOWED)
    by_group: dict[str, list[str]] = {}
    for name in ALL_TOOL_NAMES:
        if name in _ALWAYS_ALLOWED:
            continue
        group = tool_group(name)
        if group in wanted:
            by_group.setdefault(group, []).append(name)

    lines = [text["heading"], "", text["always_available"]]
    lines += [f"- `{t}`" for t in always_on]
    for group in sorted(by_group):
        lines.append(f"\n**{group}**:")
        lines += [f"- `{t}`" for t in sorted(by_group[group])]
    lines.append(text["footer"])
    return "\n".join(lines)


_RUNTIME_NOTES_TEXT: dict[str, dict[str, str]] = {
    "ko": {
        "heading": "## 런타임 노트",
        "identifier": "이 프로젝트에서 당신의 실행 런타임은 `{runtime}` 입니다.",
        "mcp_native": (
            "MCP 연결/스코프는 채용 시 제공된 번들이 이미 구성했습니다 — 별도 설정이 필요 없습니다."
        ),
        "connector": (
            "이 런타임은 MCP가 아니라 SSE 커넥터 방식으로 연결합니다 — 채용 시 제공된 번들만으론 "
            "연결이 자동 구성되지 않습니다. `connectors/{adapter}-sprintable/` 폴더를 복사해 "
            "README 안내대로 `AGENT_API_KEY` 등 환경변수를 설정하고 어댑터를 직접 실행하세요."
        ),
        "connector_placeholder": "<선택한 런타임>",
        "override_label": "**{runtime} 전용 노트**:",
    },
    "en": {
        "heading": "## Runtime Notes",
        "identifier": "Your execution runtime in this project is `{runtime}`.",
        "mcp_native": (
            "MCP connection/scope was already configured by the bundle provided at recruitment "
            "time — no separate setup is needed."
        ),
        "connector": (
            "This runtime connects via an SSE connector, not MCP — the bundle provided at "
            "recruitment time doesn't auto-configure the connection. Copy the "
            "`connectors/{adapter}-sprintable/` folder, set env vars like `AGENT_API_KEY` per "
            "its README, and run the adapter yourself."
        ),
        "connector_placeholder": "<the runtime you selected>",
        "override_label": "**{runtime}-specific note**:",
    },
}


def _runtime_notes(
    runtime: str, runtime_overrides: dict[str, Any] | None, locale: str = "ko",
) -> str:
    """[E] 런타임 노트 — runtime_overrides(JSONB)에 해당 runtime 항목이 있으면 이어붙인다.

    전 런타임 올지원(story 6f6ac081) 까심 QA 후속(2026-07-08): MCP-native 런타임만 채용 번들이
    `.mcp.json`을 구성해 "별도 설정 불요"가 참이다. 커넥터-라우팅 런타임(MCP_NATIVE_RUNTIMES
    밖 — connector 버킷 + 5종 커넥터 전용)은 `mcp_config=None`이라 그 문구가 거짓이었다(까심이
    `compose_prompt(runtime="grok")`로 재현) — 실제로는 `connectors/{runtime}-sprintable/`
    복사 + `AGENT_API_KEY` env 설정 + 어댑터 실행이 필요하다. 정직한 두 갈래로 분기.

    E-I18N Phase A: 위 문구 전부 locale 분기(코드 상수 — [[no-pr-for-data]] 무관).
    """
    text = _RUNTIME_NOTES_TEXT[locale]
    lines = [text["heading"], "", text["identifier"].format(runtime=runtime)]
    if runtime in MCP_NATIVE_RUNTIMES:
        lines.append(text["mcp_native"])
    else:
        adapter = runtime if runtime != "connector" else text["connector_placeholder"]
        lines.append(text["connector"].format(adapter=adapter))
    override = (runtime_overrides or {}).get(runtime)
    if override:
        lines += ["", text["override_label"].format(runtime=runtime), str(override)]
    return "\n".join(lines)


_SECTION_A_HEADER: dict[str, str] = {
    "ko": "# {name} — Sprintable 역할 컨텍스트",
    "en": "# {name} — Sprintable Role Context",
}
_SECTION_B_TEXT: dict[str, dict[str, str]] = {
    "ko": {
        "heading": "## Sprintable 워크플로",
        "footer": (
            "\n이 조직의 워크플로는 여기 고정해두지 않습니다(팀마다 커스터마이즈하므로 stale해질 "
            "수 있어서입니다) — 스스로 `sprintable_get_workflow_guide`를 불러 최신 운영법을 "
            "확인하세요."
        ),
    },
    "en": {
        "heading": "## Sprintable Workflow",
        "footer": (
            "\nThis org's workflow isn't hardcoded here (teams customize it, so a fixed copy "
            "would go stale) — proactively call `sprintable_get_workflow_guide` yourself to "
            "check the current operating procedure."
        ),
    },
}
# 채용-kit 재설계(story b1fe41cf, 문서 `recruit-output-kit-redesign-crux`, 선생님 GO
# 2026-07-08 결정③): kit 말미의 자기통합/메모리 유도 지시문 — 정적 텍스트 주입이 아니라
# "전달받은 에이전트가 스스로 판단해 자기 메모리에 반영"하도록 유도한다(선생님 원안 문구
# 그대로, en은 그 의미를 보존한 번역). **기존 정체성을 덮지 말라**는 명시적 경고가 핵심.
_INTEGRATION_PROMPT_TEXT: dict[str, str] = {
    "ko": """## 전달받은 에이전트에게

이 문서는 당신 자신의 정체성 파일(CLAUDE.md/AGENTS.md 등)이 아니라, 이 Sprintable 조직에서
활동하기 위한 컨텍스트 kit입니다. 다음을 스스로 판단해 당신의 메모리(또는 이미 쓰고 있는
메모리/시스템 체계)에 반영하세요 — 이 파일 내용을 그대로 복사해 자신을 덮어쓰지 마세요:

- 이 조직에서 당신이 맡은 역할(위 "역할 컨텍스트" 참고)
- 자주 쓰게 될 `sprintable_*` 도구(위 "사용 가능 도구" 참고)
- 워크플로는 고정 절차로 외우지 말고, 매번 `sprintable_get_workflow_guide`로 최신 확인

**기존 정체성을 덮지 말고, 당신 방식대로 자기화하세요.**""",
    "en": """## To the agent receiving this

This document is not your own identity file (CLAUDE.md/AGENTS.md, etc.) — it's a context kit
for operating in this Sprintable org. Use your own judgment to fold the following into your
memory (or whatever memory/system you already use) — don't copy this file verbatim over
yourself:

- Your role in this org (see "Role Context" above)
- The `sprintable_*` tools you'll use often (see "Available Tools" above)
- Don't memorize the workflow as a fixed procedure — re-check it every time via
  `sprintable_get_workflow_guide`

**Don't overwrite your existing identity — integrate this in your own way.**""",
}


def compose_kit(
    role_template: Any,
    runtime: str,
    locale: str = "ko",
) -> dict[str, str]:
    """채용 kit 합성 — 순수 함수(네트워크/DB 호출 0·부수효과 0. G4).

    채용-kit 재설계(story b1fe41cf, 문서 `recruit-output-kit-redesign-crux`, 선생님 GO
    2026-07-08)로 옛 `compose_prompt`(CLAUDE.md **전체 대체**를 노린 단일 문자열)를 대체한다.
    유저가 이미 자기 정체성을 가진 에이전트를 쓴다는 전제 — 이 kit은 그 정체성을 덮어쓰는 게
    아니라, "이 조직에서 이 역할로 일하는 법"을 전달해 에이전트가 스스로 자기화하게 한다.

    Args:
        role_template: role_templates 행(또는 동형 속성을 가진 객체) — role_behaviors·
            default_tool_groups·runtime_overrides 를 속성으로 읽는다(duck-typing).
        runtime: 실행 런타임 식별자.
        locale: "ko"|"en" — 미지원 값은 호출부가 `resolve_locale()`로 정규화해 넘겨야 한다
            (이 함수는 방어적 폴백 없음 — `validate_tool_groups`와 동일한 fail-closed 철학).

    Returns:
        구조화된 kit dict — ``{role_context, onboarding, workflow_pointer, integration_prompt}``.
        키 순서가 곧 권장 표시/결합 순서(다운로드 파일에서 이 순서로 이어붙임). 하위호환이
        필요하면(예: DB의 단일 ``system_prompt`` 컬럼) 호출부가 ``"\\n\\n".join(kit.values())``로
        문자열 재구성 가능 — 라이브 오케스트레이션 소비자가 없어(§크럭스 §0 확인) 순서/포맷
        변경 자체는 breaking이 아니다.

    분류 근거(크럭스 §1): **role_context**([A], 지속) — 이 조직에서 맡은 역할, 기존 정체성을
    대체하지 않는 추가 컨텍스트. **onboarding**([C]+[D]+[E] 병합, 일회성) — 도구 목록·운영
    룰·연결 셋업, 처음 한 번 알면 되는 내용. **workflow_pointer**([B], recipe 하드코딩 제거) —
    워크플로는 팀이 커스터마이즈하는 유저것이라 고정 텍스트 대신 `sprintable_get_workflow_guide`
    자가-pull 유도만 남긴다. **integration_prompt**(신규) — 정적 주입이 아니라 에이전트 스스로
    메모리에 반영하도록 유도하는 지시문(결정③), 기존 정체성 보존을 명시.
    """
    role_context = (
        _SECTION_A_HEADER[locale].format(name=role_template.name)
        + f"\n\n{role_template.role_behaviors}"
    )

    onboarding = "\n\n".join([
        _tool_cheat_sheet(list(role_template.default_tool_groups), locale),
        _AGILE_OPERATING_RULES[locale],
        _runtime_notes(runtime, getattr(role_template, "runtime_overrides", None), locale),
    ])

    guide_text = _SECTION_B_TEXT[locale]
    workflow_pointer = "\n".join([guide_text["heading"], guide_text["footer"]])

    return {
        "role_context": role_context,
        "onboarding": onboarding,
        "workflow_pointer": workflow_pointer,
        "integration_prompt": _INTEGRATION_PROMPT_TEXT[locale],
    }
