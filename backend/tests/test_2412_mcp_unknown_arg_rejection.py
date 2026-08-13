"""story #2412 AC2 — MCP 도구가 미선언 인자(`days` 등)를 조용히 삼키던 것.

⚠️실제 삼킴 지점은 처음 지목됐던 SprintableInput.extra="ignore"가 아니라 한 겹 앞이었다 —
FastMCP가 도구 함수 시그니처(_flat()의 wrapper.__signature__)로 만드는 내부 arg_model(mcp
SDK `func_metadata.py`)이 먼저 거른다(extra 미지정 → pydantic 기본값=ignore와 동일). 이
테스트는 `Tool.run()`으로 끝까지 태워 그 실제 경로를 검증한다(SprintableInput만 직접
구성(`SomeInput(**kwargs)`)해서는 이 층을 안 지나가므로 이 증상을 못 잡는다 — 그게 바로
처음 판단이 틀렸던 이유).

positive control(AC4): 아래 첫 테스트가 "패치 전" 상태(관대한 원본 arg_model)를 직접
재현해 여전히 조용히 삼킨다는 것부터 보여준 뒤, 실제 등록된(=server.py의
`SprintableFastMCP.add_tool` 패치가 적용된) 도구가 정확히 거부한다는 것을 대조한다.
"""
from __future__ import annotations

import sys

import pytest

sys.path.insert(0, ".")


@pytest.mark.anyio
async def test_baseline_unpatched_arg_model_silently_drops_unknown_kwarg():
    """positive control — 패치 전 FastMCP 기본 동작 자체가 조용히 삼킨다는 것을 직접 재현.
    이게 실측 없이 「SprintableInput만 고치면 된다」고 믿기 쉬웠던 지점이다."""
    from mcp.server.fastmcp.tools.base import Tool

    captured = {}

    async def wrapper(limit: int | None = None, project_id: str | None = None):
        captured["received"] = {"limit": limit, "project_id": project_id}
        return []

    tool = Tool.from_function(wrapper, name="unpatched_probe")
    # wrapper 시그니처엔 애초에 존재하지 않는 인자 — MCP 클라가 미지 필드(days같은)를 보내는
    # 상황을 재현. 패치 전 baseline은 이걸 조용히 버리고 정상 200류 응답을 낸다(에러 0).
    result = await tool.run({"limit": 5, "some_field_wrapper_never_declared": 14})
    assert result == []
    assert captured["received"] == {"limit": 5, "project_id": None}, (
        "패치 전 baseline은 wrapper 시그니처에 없는 인자를 조용히 버린다(에러 없음) — "
        "이게 스토리가 보고한 증상의 실제 원인."
    )


@pytest.mark.anyio
async def test_registered_standup_history_tool_rejects_unknown_days_arg():
    """AC2 본체 — 실제 등록된(server.py, lockdown 패치 적용됨) 도구로 스토리 repro를 재현."""
    from sprintable_mcp import server as srv
    from mcp.server.fastmcp.exceptions import ToolError

    tool = srv.mcp._tool_manager.get_tool("sprintable_standup_history")
    with pytest.raises(ToolError) as ei:
        await tool.run({"limit": 5, "totally_bogus_arg": 1})
    msg = str(ei.value)
    assert "totally_bogus_arg" in msg
    assert "accepted arguments" in msg, "거부 메시지가 accepted 인자 목록을 말해야 한다(올리베이라군 요청 — «다음 발»을 줘야 함)"
    assert "limit" in msg and "project_id" in msg


@pytest.mark.anyio
async def test_registered_standup_history_tool_still_accepts_known_args():
    """회귀 방지 — lockdown이 정상 콜까지 깨면 안 된다."""
    from sprintable_mcp import server as srv

    tool = srv.mcp._tool_manager.get_tool("sprintable_standup_history")
    result = await tool.run({"limit": 5, "days": 7})
    assert isinstance(result, list)


def test_all_registered_tools_share_the_same_lockdown():
    """AC2 카운트 — `_TOOL_DEFS` 118개 + ping 1개 = 119개(story #2634: sprintable_publish_event/
    sprintable_list_event_definitions 추가로 117→119) 전부 arg_model이 extra=forbid로 잠겨
    있어야 한다(상속 갈래 SprintableInput/BaseModel 안 가리고 전부)."""
    from sprintable_mcp import server as srv

    tools = srv.mcp._tool_manager.list_tools()
    assert len(tools) == 119
    unlocked = [
        t.name for t in tools
        if t.fn_metadata.arg_model.model_config.get("extra") != "forbid"
    ]
    assert unlocked == [], f"lockdown이 안 걸린 도구가 있다: {unlocked}"


@pytest.mark.anyio
async def test_baseclass_direct_outliers_also_reject_unknown_kwarg():
    """115/115 카운트에서 SprintableInput을 상속 안 하는 2개(list_projects·set_default_project,
    tools/projects.py) — SprintableInput만 고쳤으면 놓쳤을 자리. 스키마 레벨(defense-in-depth)
    로도 직접 확認."""
    from sprintable_mcp.tools.projects import ListProjectsInput, SetDefaultProjectInput
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        ListProjectsInput(bogus="x")
    with pytest.raises(ValidationError):
        SetDefaultProjectInput(project_id="p1", bogus="x")


def test_sprintable_input_extra_forbid_defense_in_depth():
    """SprintableInput.extra="forbid" — MCP 호출 경로 밖(예: 테스트 코드)에서 직접
    `SomeInput(**kwargs)`로 구성하는 경우까지 잠그는 defense-in-depth(진짜 fix는 위 lockdown)."""
    from sprintable_mcp.tools.standup import StandupHistoryInput
    from pydantic import ValidationError

    # days는 AC3에서 진짜 필드가 됐으니 통과해야 정상 — 회귀 방지 겸.
    ok = StandupHistoryInput(limit=5, days=14)
    assert ok.days == 14

    with pytest.raises(ValidationError):
        StandupHistoryInput(limit=5, totally_unknown_field=1)


def test_days_ge_1_boundary_matches_backend():
    """올리베이라군 QA 요청 — 배포 뒤 볼 것 ②(days 경계). MCP 쪽에 ge=1 없으면 days=0/음수가
    MCP는 조용히 통과하고 BE(`Query(..., ge=1)`)에서만 422로 막혀 raw HTTP 에러 문자열이
    호출자에게 그대로 샌다 — MCP 스키마 경계를 BE와 맞춰서 막는다."""
    from sprintable_mcp.tools.standup import StandupHistoryInput
    from pydantic import ValidationError

    for bad in (0, -1, -100):
        with pytest.raises(ValidationError):
            StandupHistoryInput(limit=5, days=bad)

    assert StandupHistoryInput(limit=5, days=1).days == 1
    assert StandupHistoryInput(limit=5, days=365).days == 365  # 상한 없음(BE도 무상한 — 대칭)
