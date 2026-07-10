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
    # core + 16 비파괴 + admin = 18 (E1-S5 hypotheses 그룹 추가)
    assert len(groups) == 18
    for g in groups:
        assert set(g.keys()) == _CONTRACT_FIELDS, f"{g['key']} 필드 계약 불일치"
        assert isinstance(g["key"], str) and g["key"]
        assert isinstance(g["tools"], list) and all(isinstance(t, str) for t in g["tools"])
        assert isinstance(g["is_core"], bool) and isinstance(g["is_destructive"], bool)
        assert isinstance(g["order"], int)
        assert g["tools"], f"{g['key']} 빈 그룹 — 모든 그룹은 멤버 보유"
    # order = 배열 순서와 일치(0..17 단조)
    assert [g["order"] for g in groups] == list(range(18))


def test_core_first_admin_last_flags():
    groups = build_toolset_catalog()["groups"]
    assert groups[0]["key"] == "core" and groups[0]["is_core"] and not groups[0]["is_destructive"]
    assert groups[-1]["key"] == "admin" and groups[-1]["is_destructive"] and not groups[-1]["is_core"]
    # is_core 는 core 만, is_destructive 는 admin 만
    assert [g["key"] for g in groups if g["is_core"]] == ["core"]
    assert [g["key"] for g in groups if g["is_destructive"]] == ["admin"]


def test_group_keys_match_mcp_toolset_ssot():
    keys = [g["key"] for g in build_toolset_catalog()["groups"]]
    # core + admin + ALL_GROUPS 비-core = 전체
    assert "core" in keys and "admin" in keys
    non_core_admin = {k for k in keys if k not in ("core", "admin")}
    assert non_core_admin == {g for g in ALL_GROUPS if g != "core"}  # 16 비파괴 그룹


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
    assert by_tool["sprintable_delete_meeting"] == "meetings"
    assert by_tool["sprintable_give_reward"] == "rewards"
    assert by_tool["sprintable_delete_sprint"] == "sprints"
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
