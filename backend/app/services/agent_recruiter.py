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

from app.routers.workflow_recipes import _generate_guide
from app.services.agent_onboarding_config import MCP_NATIVE_RUNTIMES
from app.services.mcp_toolset import ALL_GROUPS, ALL_TOOL_NAMES, _ALWAYS_ALLOWED, tool_group

_AGILE_OPERATING_RULES = """## 애자일 자율 운영 룰

- **claim**: 작업을 시작하기 전에 반드시 claim 하세요. 이미 누군가 진행 중인 작업을 가로채지 마세요.
- **lock**: 같은 파일을 동시에 여러 에이전트가 건드릴 수 있는 작업이면 시작 전 잠그고, 끝나면 즉시 풉니다.
- **status**: 작업 시작·완료·블로커 발생 시점마다 상태를 갱신하세요. 상태가 실제 진행과 어긋나면 팀 전체가 헷갈립니다.
- **소통**: 막히거나 방향을 바꿨거나 완료했으면 침묵하지 말고 즉시 채팅으로 알리세요. 아무도 몰래 혼자 진행하지 마세요.
- **정직**: 실제로 확인/실행하지 않은 것을 완료로 보고하지 마세요. 근거(실행 결과·재현 절차)와 함께 보고하세요.
"""


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


def _tool_cheat_sheet(tool_groups: list[str]) -> str:
    """[C] tool 치트시트 — 그룹→**실 등록 도구명**(ALL_TOOL_NAMES·tool_group() SSOT 파생. G3).

    core(_ALWAYS_ALLOWED) 도구는 role 무관 항상 포함 — 그 어떤 scope 로도 항상 허용되는 도구라
    치트시트에서 빠지면 존재를 모른 채 있는 것처럼 재발명할 위험이 있다.
    """
    validate_tool_groups(tool_groups)
    wanted = set(tool_groups)
    always_on = sorted(t for t in ALL_TOOL_NAMES if t in _ALWAYS_ALLOWED)
    by_group: dict[str, list[str]] = {}
    for name in ALL_TOOL_NAMES:
        if name in _ALWAYS_ALLOWED:
            continue
        group = tool_group(name)
        if group in wanted:
            by_group.setdefault(group, []).append(name)

    lines = ["## 사용 가능 도구 (치트시트)", "", "**항상 사용 가능**:"]
    lines += [f"- `{t}`" for t in always_on]
    for group in sorted(by_group):
        lines.append(f"\n**{group}**:")
        lines += [f"- `{t}`" for t in sorted(by_group[group])]
    lines.append(
        "\n위 목록에 없는 도구 이름을 지어내지 마세요 — 확실하지 않으면 "
        "`sprintable_get_workflow_guide`로 먼저 확인하세요."
    )
    return "\n".join(lines)


def _runtime_notes(runtime: str, runtime_overrides: dict[str, Any] | None) -> str:
    """[E] 런타임 노트 — runtime_overrides(JSONB)에 해당 runtime 항목이 있으면 이어붙인다.

    전 런타임 올지원(story 6f6ac081) 까심 QA 후속(2026-07-08): MCP-native 런타임만 채용 번들이
    `.mcp.json`을 구성해 "별도 설정 불요"가 참이다. 커넥터-라우팅 런타임(MCP_NATIVE_RUNTIMES
    밖 — connector 버킷 + 5종 커넥터 전용)은 `mcp_config=None`이라 그 문구가 거짓이었다(까심이
    `compose_prompt(runtime="grok")`로 재현) — 실제로는 `connectors/{runtime}-sprintable/`
    복사 + `AGENT_API_KEY` env 설정 + 어댑터 실행이 필요하다. 정직한 두 갈래로 분기.
    """
    lines = ["## 런타임 노트", "", f"이 프로젝트에서 당신의 실행 런타임은 `{runtime}` 입니다."]
    if runtime in MCP_NATIVE_RUNTIMES:
        lines.append(
            "MCP 연결/스코프는 채용 시 제공된 번들이 이미 구성했습니다 — 별도 설정이 필요 없습니다."
        )
    else:
        lines.append(
            "이 런타임은 MCP가 아니라 SSE 커넥터 방식으로 연결합니다 — 채용 시 제공된 번들만으론 "
            "연결이 자동 구성되지 않습니다. `connectors/{}-sprintable/` 폴더를 복사해 README "
            "안내대로 `AGENT_API_KEY` 등 환경변수를 설정하고 어댑터를 직접 실행하세요."
            .format(runtime if runtime != "connector" else "<선택한 런타임>")
        )
    override = (runtime_overrides or {}).get(runtime)
    if override:
        lines += ["", f"**{runtime} 전용 노트**:", str(override)]
    return "\n".join(lines)


def compose_prompt(
    role_template: Any,
    recipe: dict[str, Any] | None,
    runtime: str,
) -> str:
    """자율 운영 지침 합성 — 순수 함수(네트워크/DB 호출 0·부수효과 0. G4).

    Args:
        role_template: role_templates 행(또는 동형 속성을 가진 객체) — role_behaviors·
            default_tool_groups·runtime_overrides 를 속성으로 읽는다(ORM 인스턴스·SimpleNamespace
            등 duck-typing — dict 도 `.get`이 아니라 속성 접근이 필요하면 호출부가 변환).
        recipe: workflow_recipes 형태의 dict({name, description, steps, ...}) 또는 None(추천
            워크플로우 없음 — 섹션 [B] 워크플로우 가이드 부분만 생략, 나머지 섹션은 정상 생성).
        runtime: 실행 런타임 식별자(예: "claude-code").

    Returns:
        5섹션([A]~[E])을 이어붙인 markdown 문자열(diffable — 순수 문자열 결합, LLM 비호출).
    """
    sections = [
        f"# {role_template.name} — 채용 지침\n\n{role_template.role_behaviors}",
    ]

    guide_section = ["## Sprintable 사용법"]
    if recipe is not None:
        guide_section.append(_generate_guide(recipe))
    guide_section.append(
        "\n이 가이드가 오래됐다고 느껴지거나 막히면, 플랫폼이 알려주길 기다리지 말고 "
        "스스로 `sprintable_get_workflow_guide`를 불러 최신 운영법을 확인하세요."
    )
    sections.append("\n".join(guide_section))

    sections.append(_tool_cheat_sheet(list(role_template.default_tool_groups)))
    sections.append(_AGILE_OPERATING_RULES)
    sections.append(_runtime_notes(runtime, getattr(role_template, "runtime_overrides", None)))

    return "\n\n".join(sections)
