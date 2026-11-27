"""E-MCP-RIGHT S1 (2da32fbf): toolset-catalog 엔드포인트 + builder 회귀.

계약(FE `lib/toolset-catalog.ts`): {groups:[{key, tools[], is_core, is_destructive, order}]}.
검증: 그룹키 SSOT 정합·core/admin 플래그·tool 커버리지(무손실/무중복)·매핑·admin 게이트.
"""
from __future__ import annotations

import uuid
from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from app.services.mcp_toolset import (
    ALL_GROUPS,
    ALL_TOOL_NAMES,
    build_toolset_catalog,
    tool_group,
)

_CONTRACT_FIELDS = {"key", "tools", "is_core", "is_destructive", "order"}


@pytest.fixture
def anyio_backend():
    return "asyncio"


def test_catalog_structure_and_contract_fields():
    cat = build_toolset_catalog()
    assert set(cat.keys()) == {"groups"}
    groups = cat["groups"]
    # core + 18 비파괴(story b4027b2e: canvas 그룹 추가·story 205e6831: standup이 core로 전량
    # 흡수돼 카탈로그 그룹 목록에서 제거 — _GROUP_KEYWORDS/ALL_GROUPS엔 여전히 존재, 여긴 picker
    # 표시 목록만·story #2634: events 그룹 추가·story #3614 CHANGES: content 그룹 신설,
    # 19→20) + admin = 20
    assert len(groups) == 20
    for g in groups:
        assert set(g.keys()) == _CONTRACT_FIELDS, f"{g['key']} 필드 계약 불일치"
        assert isinstance(g["key"], str) and g["key"]
        assert isinstance(g["tools"], list) and all(isinstance(t, str) for t in g["tools"])
        assert isinstance(g["is_core"], bool) and isinstance(g["is_destructive"], bool)
        assert isinstance(g["order"], int)
        assert g["tools"], f"{g['key']} 빈 그룹 — 모든 그룹은 멤버 보유"
    # order = 배열 순서와 일치(0..19 단조)
    assert [g["order"] for g in groups] == list(range(20))


def test_core_first_admin_last_flags():
    groups = build_toolset_catalog()["groups"]
    assert groups[0]["key"] == "core" and groups[0]["is_core"] and not groups[0]["is_destructive"]
    assert groups[-1]["key"] == "admin" and groups[-1]["is_destructive"] and not groups[-1]["is_core"]
    # is_core 는 core 만, is_destructive 는 admin 만
    assert [g["key"] for g in groups if g["is_core"]] == ["core"]
    assert [g["key"] for g in groups if g["is_destructive"]] == ["admin"]


def test_group_keys_match_mcp_toolset_ssot():
    keys = [g["key"] for g in build_toolset_catalog()["groups"]]
    # core + admin + ALL_GROUPS 비-core = 전체 — story 205e6831 예외: "standup"은 ALL_GROUPS엔
    # 남아있지만(pm/scrum-master role_template.default_tool_groups 하위호환용 literal 토큰,
    # validate_tool_groups unknown-group 방지) 스탠드업 5종 전부가 core로 흡수돼 카탈로그엔
    # 빈 그룹으로 안 나타난다("standup" != core 그러나 catalog엔 미표시).
    assert "core" in keys and "admin" in keys
    non_core_admin = {k for k in keys if k not in ("core", "admin")}
    assert non_core_admin == {g for g in ALL_GROUPS if g not in ("core", "standup")}


def test_every_tool_covered_exactly_once():
    groups = build_toolset_catalog()["groups"]
    flat = [t for g in groups for t in g["tools"]]
    # 무중복
    assert len(flat) == len(set(flat)), "그룹 간 tool 중복"
    # 무손실 — ALL_TOOL_NAMES 전량 커버(core 통합 always-allowed 포함)
    assert set(flat) == set(ALL_TOOL_NAMES)


def test_tool_group_mapping_examples():
    by_tool = {t: g["key"] for g in build_toolset_catalog()["groups"] for t in g["tools"]}
    # 도메인 destructive 는 도메인 그룹(admin 아님)
    # E-SECURITY SEC-S1(확장): sprintable_delete_story/task/epic/doc 제거(에이전트 hard-delete
    # 차단) — delete_meeting으로 대체 예시(에이전트 MCP 표면에 남는 도메인 destructive 도구)
    # E-SECURITY SEC-S8 확장: sprintable_delete_sprint도 동일 사유로 제거.
    assert by_tool["sprintable_delete_meeting"] == "meetings"
    assert by_tool["sprintable_give_reward"] == "rewards"
    # admin 그룹 = emit_event/trigger_ai/activate_sprint/close_sprint 등 진짜 파괴 작업만
    assert by_tool["sprintable_emit_event"] == "admin"
    # always-allowed(+orphan)는 core 로 통합(키워드 그룹서 제외)
    assert by_tool["sprintable_my_dashboard"] == "core"
    assert by_tool["sprintable_check_notifications"] == "core"
    assert by_tool["sprintable_get_workflow_guide"] == "core"
    assert by_tool["sprintable_list_team_members"] == "core"
    assert by_tool["sprintable_poll_events"] == "core"
    # S17: lock/unlock 은 org/project-scoped advisory 조율 도구(비파괴)로 재분류 — core(always-allow)
    assert by_tool["sprintable_lock_files"] == "core"
    assert by_tool["sprintable_unlock_files"] == "core"
    # 정상 그룹 매핑 sanity
    assert by_tool["sprintable_add_story"] == "stories"
    assert by_tool["sprintable_get_velocity"] == "analytics"
    # story #2010: sprintable_transition_goal — ALL_TOOL_NAMES 누락 시 KeyError로 실패(당초
    # 이 도구가 SSOT 목록에서 빠져 role-template picker/치트시트에 노출되지 않던 회귀 가드).
    # "goal" substring 매칭으로 add_goal/update_goal/list_goals와 동일 "epics" 그룹.
    assert by_tool["sprintable_transition_goal"] == "epics"
    # story #1922: sprintable_delete_artifact — ALL_TOOL_NAMES 누락 시 KeyError(#2010과 동일
    # 회귀 클래스, 이번엔 최초 커밋부터 등록해 애초에 발생하지 않게 함 — 이 assert는 그 보장의
    # 회귀 가드). "artifact" substring 매칭으로 create_artifact/edit_artifact/delete_spec_pin과
    # 동일 "canvas" 그룹.
    assert by_tool["sprintable_delete_artifact"] == "canvas"
    # story 5040: 시작 안 한 스프린트 접기 — admin 이 아닌 일반 sprints 그룹(ALL_TOOL_NAMES 누락 시 KeyError).
    assert by_tool["sprintable_cancel_planning_sprint"] == "sprints"


# ── story 5040: cancel_planning_sprint 는 비파괴 · close_sprint 는 그대로 파괴적 ──────────────

@pytest.mark.parametrize("module_path", ["app.services.mcp_toolset", "sprintable_mcp.toolset"])
def test_cancel_planning_sprint_non_destructive_close_sprint_still_blocked(module_path):
    """backend SSOT 와 vendored 사본 둘 다 — 기본(빈) · 레거시(read/write) 키는 cancel 허용 · close 차단,
    admin/destructive 스코프는 둘 다 허용, 그룹 명시 키는 sprints 그룹 보유 때만 cancel 허용."""
    import importlib

    m = importlib.import_module(module_path)
    cancel, close = "sprintable_cancel_planning_sprint", "sprintable_close_sprint"

    assert m.tool_group(cancel) == "sprints"
    assert m.is_destructive(cancel) is False
    assert m.is_destructive(close) is False      # story 5041 — the server answers a close with a card, the tool is not hidden

    for scope in (None, [], ["read", "write"], ["write"]):
        assert m.is_tool_allowed(cancel, scope) is True, scope
        assert m.is_tool_allowed(close, scope) is True, scope

    # (["admin"] 단독은 그룹 명시 키로 취급돼 sprints 그룹이 없어 close 도 막힘 — 기존 동작이라 여기선 안 건드림)
    for scope in (["destructive"], ["sprints", "destructive"], ["sprints", "admin"], ["read", "write", "destructive"]):
        assert m.is_tool_allowed(cancel, scope) is True, scope
        assert m.is_tool_allowed(close, scope) is True, scope

    # 그룹 명시 키 — 도구 이름이 아니라 그룹 스코프가 여전히 적용된다.
    assert m.is_tool_allowed(cancel, ["sprints"]) is True
    assert m.is_tool_allowed(close, ["sprints"]) is True      # story 5041 — a group key that holds `sprints` sees close_sprint: the server answers with a card
    assert m.is_tool_allowed(close, ["docs"]) is False      # …but the GROUP still applies
    assert m.is_tool_allowed(cancel, ["docs"]) is False


def test_cancel_planning_sprint_in_manifest_for_default_key():
    from app.services.mcp_toolset import resolve_manifest

    m = resolve_manifest(["read", "write"], list(ALL_TOOL_NAMES))
    assert "sprintable_cancel_planning_sprint" in m["allowed_tools"]
    assert "sprintable_close_sprint" in m["allowed_tools"]      # story 5041 — no longer hidden from a default key


# ── 엔드포인트 admin 게이트 ────────────────────────────────────────────────────

async def _client(role: str):
    from app.main import app
    from app.dependencies.auth import get_current_user

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.claims = {"app_metadata": {"org_id": str(uuid.uuid4()), "role": role}}

    async def _auth():
        return ctx

    app.dependency_overrides[get_current_user] = _auth
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), app


@pytest.mark.anyio
async def test_endpoint_admin_200_bare_groups():
    client, app = await _client("admin")
    try:
        async with client as c:
            resp = await c.get("/api/v2/mcp/toolset-catalog")
        assert resp.status_code == 200
        body = resp.json()
        # BE 는 bare {groups} (FE route 가 v2 엔벨로프 래핑 — 이중래핑 방지)
        assert "groups" in body and isinstance(body["groups"], list)
        assert {g["key"] for g in body["groups"]} >= {"core", "stories", "admin"}
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_endpoint_owner_200():
    client, app = await _client("owner")
    try:
        async with client as c:
            resp = await c.get("/api/v2/mcp/toolset-catalog")
        assert resp.status_code == 200
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_endpoint_non_admin_403():
    client, app = await _client("member")
    try:
        async with client as c:
            resp = await c.get("/api/v2/mcp/toolset-catalog")
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()
