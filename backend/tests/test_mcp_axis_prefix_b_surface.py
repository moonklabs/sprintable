"""도메인 축 B §3(org-1st-class-surface-ia-design-b): MCP 툴 description 카테고리 프리픽스.

툴 이름·파라미터는 불변 — description 문자열 맨 앞에 [조직]/[일감]/[신뢰]/[지식]만 추가.
core(cross-cutting) 툴은 단일 축이 아니므로 프리픽스 제외(mcp_toolset.py _ALWAYS_ALLOWED와 동형).
"""
from __future__ import annotations

import os

os.environ.setdefault("SPRINTABLE_API_URL", "http://test")
os.environ.setdefault("AGENT_API_KEY", "sk_test")

from sprintable_mcp.server import _TOOL_DEFS  # noqa: E402

_TOOLS = {name: desc for name, desc, *_ in _TOOL_DEFS}
_VALID_PREFIXES = ("[조직] ", "[일감] ", "[신뢰] ", "[지식] ")

# mcp_toolset.py _ALWAYS_ALLOWED와 동형 — cross-cutting core 유틸(단일 축 아님).
_CORE_NO_PREFIX = {
    "sprintable_my_dashboard", "sprintable_check_notifications", "sprintable_get_workflow_guide",
    "sprintable_list_team_members", "sprintable_poll_events", "sprintable_get_loop_context",
    "sprintable_lock_files", "sprintable_unlock_files", "sprintable_link_gate_to_task",
    "sprintable_add_evidence", "sprintable_list_projects", "sprintable_set_default_project",
    "sprintable_add_judgment", "sprintable_list_judgments",
    "sprintable_get_session_context",
    # story #2597: list_agent_cards — mcp_toolset.py _ALWAYS_ALLOWED와 동기화(core 취급 사유는
    # 거기 주석 참조 — 어떤 role이든 필요한 cross-cutting 발견 유틸, 단일 축 아님).
    "sprintable_list_agent_cards",
}


def test_every_non_core_tool_has_exactly_one_axis_prefix():
    missing = []
    for name, desc in _TOOLS.items():
        if name in _CORE_NO_PREFIX:
            continue
        if not desc.startswith(_VALID_PREFIXES):
            missing.append(name)
    assert not missing, f"프리픽스 누락: {missing}"


def test_core_tools_have_no_axis_prefix():
    """core 툴은 설계상 단일 도메인이 아니므로 프리픽스가 붙으면 안 된다(과확대 가드)."""
    wrongly_prefixed = [
        n for n in _CORE_NO_PREFIX if n in _TOOLS and _TOOLS[n].startswith("[")
    ]
    assert not wrongly_prefixed, f"core 툴에 프리픽스가 잘못 붙음: {wrongly_prefixed}"


def test_bidirectional_coverage_no_silent_gap():
    """전체 도구 중 core 제외 전부가 프리픽스 대상 — 한쪽만 확인하면 신규 툴 누락을 못 잡는다."""
    prefixed = {n for n, d in _TOOLS.items() if d.startswith(_VALID_PREFIXES)}
    expected_prefixed = set(_TOOLS.keys()) - _CORE_NO_PREFIX
    assert prefixed == expected_prefixed


def test_anchor_tools_match_doc_examples():
    """doc §3 예시와 직접 대조(순환 검증 방지 — 스크립트 매핑을 재생성하지 않고 원 진술과 대조)."""
    assert _TOOLS["sprintable_list_stories"].startswith("[일감] ")
    assert _TOOLS["sprintable_get_doc"].startswith("[지식] ")
    assert _TOOLS["sprintable_list_audit_logs"].startswith("[신뢰] ")
    assert _TOOLS["sprintable_send_chat_message"].startswith("[조직] ")
    assert not _TOOLS["sprintable_my_dashboard"].startswith("[")
    assert not _TOOLS["sprintable_check_notifications"].startswith("[")


def test_tool_names_and_param_models_untouched():
    """이름·시그니처 불변 — 계층 리네이밍 B1(story 1925)이 sprintable_*_goal 4종을 신설(구
    sprintable_*_epic 4종은 deprecated 별칭 유지, 제거 아님) — 106→110. story #2010:
    sprintable_transition_goal 1종 신설(구 _epic 별칭 없음) — 110→111. story #1922:
    sprintable_delete_artifact 1종 신설(artifact soft delete, 생성자 전용) — 111→112. story #2268
    (D단계): sprintable_add_judgment/list_judgments 2종 신설(판단 칸 pull 진입점) — 112→114.
    story #2268(C-10): sprintable_get_session_context 1종 신설(세션 시작 컨텍스트 MCP 노출) —
    114→115. story #2597(E-AGENT-ONBOARD·A2A발견 P0-1): sprintable_list_agent_cards 1종
    신설(A2A AgentCard 발견) — 115→116. story #2634: sprintable_publish_event/
    sprintable_list_event_definitions 2종 신설(이벤트 레지스트리 발행/카탈로그) — 116→118.
    story #2636: sprintable_register_event_definition/sprintable_update_event_definition
    2종 신설(org 커스텀 이벤트 등록/수정) — 118→120."""
    assert len(_TOOL_DEFS) == 120
    assert all(name.startswith("sprintable_") for name in _TOOLS)
