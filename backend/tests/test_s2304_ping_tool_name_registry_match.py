"""story #2304 — 카탈로그(ALL_TOOL_NAMES)가 «없는 도구»를 광고하고 «있는 도구»를 숨기던 병.

배경: `_TOOL_DEFS` 밖에서 `@mcp.tool()` 데코레이터로 단독등록되는 `ping`이 실제 등록명인데,
`ALL_TOOL_NAMES`(mcp_toolset.py)는 존재하지 않는 "sprintable_ping"을 대신 담고 있었다.
`_ALWAYS_ALLOWED`가 두 이름을 다 적어 둔 덕에 권한 게이팅만 우연히 안 깨졌을 뿐 —
FE 피커 core 그룹엔 유령 도구가 노출되고 agent_recruiter 치트시트엔 진짜 ping이 빠져 있었다.

AC1: 정답은 "ping"(실등록명, 다수 기존 테스트+라이브 MCP client가 이미 이 이름으로 씀)로 확정.
AC2: `_TOOL_DEFS` 루프만 세지 않는다 — `mcp.list_tools()`(실제 등록 결과 전량)와 직접 대조한다.
AC3: agent_recruiter 치트시트가 그 실등록 집합과 어긋나면 RED.
AC4: 카운트/집합비교마다 "이 방법이 실제로 무언가를 잡는가"를 양성대조로 증명한다.
"""
from __future__ import annotations

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── AC2: 실제 등록 전량(_TOOL_DEFS 루프 + 데코레이터 단독등록분) ↔ ALL_TOOL_NAMES ──────────

@pytest.mark.anyio
async def test_all_tool_names_matches_real_mcp_registration_bidirectionally():
    """`mcp.list_tools()`가 돌려주는 실제 등록 도구명 전량과 ALL_TOOL_NAMES가 양방향으로
    일치한다 — 어느 한쪽에만 있는 도구가 없다(가드 사슬의 A↔C 갭을 여기서 막는다)."""
    from sprintable_mcp import server as srv
    from app.services import mcp_toolset as backend

    real_tools = {t.name for t in await srv.mcp.list_tools()}
    declared = set(backend.ALL_TOOL_NAMES)

    only_in_declared = declared - real_tools
    only_in_real = real_tools - declared
    assert only_in_declared == set(), f"ALL_TOOL_NAMES에만 있는 유령 이름: {only_in_declared}"
    assert only_in_real == set(), f"실등록인데 ALL_TOOL_NAMES에 없는 도구: {only_in_real}"


@pytest.mark.anyio
async def test_ping_specifically_is_the_real_registered_name():
    """AC1 확정 — "ping"이 실등록명, "sprintable_ping"은 존재하지 않는다."""
    from sprintable_mcp import server as srv

    real_names = {t.name for t in await srv.mcp.list_tools()}
    assert "ping" in real_names
    assert "sprintable_ping" not in real_names


def test_all_tool_names_no_longer_contains_ghost_sprintable_ping():
    from app.services import mcp_toolset as backend

    assert "ping" in backend.ALL_TOOL_NAMES
    assert "sprintable_ping" not in backend.ALL_TOOL_NAMES


def test_always_allowed_no_longer_double_shields_ping():
    """`_ALWAYS_ALLOWED`가 두 이름을 다 적어 두는 "우연한 방패"를 걷었다 — ping 하나만 남는다."""
    from app.services import mcp_toolset as backend

    assert "ping" in backend._ALWAYS_ALLOWED
    assert "sprintable_ping" not in backend._ALWAYS_ALLOWED


# ── AC4: 양성대조 — 이 비교 방법이 실제로 드리프트를 잡는지 뮤테이션으로 증명 ──────────

@pytest.mark.anyio
async def test_positive_control_ghost_name_in_all_tool_names_is_caught(monkeypatch):
    """ALL_TOOL_NAMES에 실재하지 않는 이름을 인위로 하나 심으면, 위 AC2 비교가 실제로 잡는다."""
    from sprintable_mcp import server as srv
    from app.services import mcp_toolset as backend

    real_tools = {t.name for t in await srv.mcp.list_tools()}
    mutated_declared = set(backend.ALL_TOOL_NAMES) | {"sprintable_definitely_not_real_xyz"}

    only_in_declared = mutated_declared - real_tools
    assert only_in_declared == {"sprintable_definitely_not_real_xyz"}


@pytest.mark.anyio
async def test_positive_control_missing_real_tool_is_caught(monkeypatch):
    """실등록 집합에서 하나를 인위로 빼면(예: ping을 제거한 척), 비교가 그 누락을 잡는다."""
    from sprintable_mcp import server as srv
    from app.services import mcp_toolset as backend

    real_tools = {t.name for t in await srv.mcp.list_tools()}
    mutated_real = real_tools - {"ping"}
    declared = set(backend.ALL_TOOL_NAMES)

    only_in_declared = declared - mutated_real
    assert "ping" in only_in_declared


# ── AC3: 치트시트가 실등록 집합에서 파생되고, 어긋나면 RED ──────────────────────────────

def test_cheat_sheet_lists_real_ping_not_ghost():
    """agent_recruiter 치트시트가 "sprintable_ping"(유령)이 아니라 "ping"(실등록명)을 항상-노출로
    낸다 — SSOT 주장(agent_recruiter.py docstring)이 실제로 지켜지는지 직접 확認."""
    from app.services.agent_recruiter import _tool_cheat_sheet

    out = _tool_cheat_sheet(["stories"], locale="ko")
    assert "`ping`" in out
    assert "`sprintable_ping`" not in out


def test_cheat_sheet_always_on_derives_from_all_tool_names_and_always_allowed():
    """치트시트의 always-on 목록은 ALL_TOOL_NAMES ∩ _ALWAYS_ALLOWED로 파생된다(손으로 안 만든다) —
    이 교집합이 정확히 _ALWAYS_ALLOWED와 같아야 한다(ALL_TOOL_NAMES가 _ALWAYS_ALLOWED 전량을
    포함해야 함, AC2가 이미 이를 보장하지만 치트시트 관점에서 다시 고정한다)."""
    from app.services import mcp_toolset as backend

    always_on = {t for t in backend.ALL_TOOL_NAMES if t in backend._ALWAYS_ALLOWED}
    assert always_on == set(backend._ALWAYS_ALLOWED), (
        f"_ALWAYS_ALLOWED 중 ALL_TOOL_NAMES에 없는 것: {set(backend._ALWAYS_ALLOWED) - always_on}"
    )


# ── build_toolset_catalog(): FE 피커 core 그룹에 ping이 정상 노출되는지 ───────────────

def test_catalog_core_group_exposes_ping_not_ghost():
    """FE 피커 SSOT 응답의 core 그룹이 "ping"을 담는다(전엔 "sprintable_" 접두사 필터 때문에
    core 버킷에서 조용히 빠졌었다) — "sprintable_ping"은 어디에도 없다."""
    from app.services.mcp_toolset import build_toolset_catalog

    catalog = build_toolset_catalog()
    core = next(g for g in catalog["groups"] if g["key"] == "core")
    assert "ping" in core["tools"]
    assert "sprintable_ping" not in core["tools"]

    all_tools = [t for g in catalog["groups"] for t in g["tools"]]
    assert all_tools.count("ping") == 1  # core에만, 다른 그룹에 중복노출 없음
