"""E-MCP S2: 키별 toolset SSOT — 그룹 매핑 / is_tool_allowed / 매니페스트 / call-time enforcement."""
import uuid
from unittest.mock import MagicMock

import pytest

from app.services.mcp_toolset import (
    ALL_GROUPS,
    is_destructive,
    is_tool_allowed,
    resolve_policy,
    tool_group,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── 그룹 매핑 (sprintable_ 접두사가 'sprint' 포함하는 함정 회피) ────────────────

def test_tool_group_strips_prefix_no_sprint_false_match():
    assert tool_group("sprintable_add_story") == "stories"
    assert tool_group("sprintable_add_task") == "tasks"
    assert tool_group("sprintable_send_chat_message") == "chat"
    assert tool_group("sprintable_get_doc") == "docs"
    assert tool_group("sprintable_get_velocity") == "analytics"
    assert tool_group("sprintable_create_sprint") == "sprints"


def test_destructive_detection():
    assert is_destructive("sprintable_delete_story")
    assert is_destructive("sprintable_give_reward")
    assert is_destructive("sprintable_close_sprint")
    assert not is_destructive("sprintable_add_story")
    assert not is_destructive("sprintable_list_stories")


def test_lock_unlock_reclassified_non_destructive():
    """S17: lock_files/unlock_files 는 file_locks.py 확인 결과 org/project-scoped advisory 조율
    도구(데이터 삭제/변경 아님) — is_destructive/admin 그룹 오분류를 근본수정. 진짜 파괴 작업
    (delete/give_reward/close_sprint)은 회귀 없이 여전히 destructive."""
    assert not is_destructive("sprintable_lock_files")
    assert not is_destructive("sprintable_unlock_files")
    assert tool_group("sprintable_lock_files") == "core"
    assert tool_group("sprintable_unlock_files") == "core"


# ── is_tool_allowed: legacy / 명시 그룹 / destructive / always ─────────────────

def test_legacy_scope_allows_nondestructive_blocks_destructive():
    # read/write(레거시) → 비파괴 전체 허용, destructive 차단
    assert is_tool_allowed("sprintable_add_story", ["read", "write"])
    assert is_tool_allowed("sprintable_send_chat_message", ["read", "write"])
    assert not is_tool_allowed("sprintable_delete_story", ["read", "write"])
    assert not is_tool_allowed("sprintable_give_reward", ["read", "write"])


def test_empty_scope_defaults_to_legacy():
    assert is_tool_allowed("sprintable_add_story", [])
    assert is_tool_allowed("sprintable_add_story", None)
    assert not is_tool_allowed("sprintable_delete_story", None)


def test_explicit_group_scopes_only_that_group():
    assert is_tool_allowed("sprintable_add_story", ["stories"])
    assert not is_tool_allowed("sprintable_add_task", ["stories"])  # tasks 그룹 차단
    assert is_tool_allowed("sprintable_add_task", ["stories", "tasks"])


def test_destructive_requires_explicit_grant():
    assert not is_tool_allowed("sprintable_delete_story", ["stories"])  # 그룹은 OK지만 destructive 차단
    assert is_tool_allowed("sprintable_delete_story", ["stories", "destructive"])
    assert is_tool_allowed("sprintable_delete_story", ["stories", "admin"])


def test_real_destructive_tools_still_blocked_without_admin_grant_after_s17():
    """S17 회귀 확인: lock/unlock 재분류가 진짜 파괴 도구(delete/give_reward/close_sprint) 게이팅을
    깨지 않는지 — 도메인 그룹만 있고 admin/destructive 미부여 시 여전히 차단되어야 한다."""
    scope = ["stories", "tasks", "sprints", "chat", "docs", "rewards"]
    assert not is_tool_allowed("sprintable_delete_story", scope)
    assert not is_tool_allowed("sprintable_give_reward", scope)
    assert not is_tool_allowed("sprintable_close_sprint", scope)
    assert not is_tool_allowed("sprintable_delete_sprint", scope)


def test_always_allowed_tools():
    assert is_tool_allowed("sprintable_ping", ["stories"])  # 핵심 도구는 그룹 무관 허용
    assert is_tool_allowed("ping", [])


def test_lock_unlock_allowed_regardless_of_domain_scope():
    """S17 AC: 파일을 다루는 모든 working role 이 자신의 default_tool_groups(도메인 그룹)와 무관하게
    lock/unlock 을 호출할 수 있어야 한다(core/always-allow) — narrow-scope 키(예: data-analyst 류,
    stories/tasks 없이 chat/docs/analytics 만 보유)로도 확인."""
    narrow_scope = ["chat", "docs", "analytics", "hypotheses"]  # stories/tasks 없음(예: data-analyst)
    assert is_tool_allowed("sprintable_lock_files", narrow_scope)
    assert is_tool_allowed("sprintable_unlock_files", narrow_scope)
    assert is_tool_allowed("sprintable_lock_files", [])
    assert is_tool_allowed("sprintable_unlock_files", None)


def test_resolve_policy():
    p = resolve_policy(["stories", "chat"])
    assert sorted(p["allowed_groups"]) == ["chat", "stories"]
    assert p["destructive_allowed"] is False
    p2 = resolve_policy(["read", "write"])  # 레거시 → 전체 비파괴 그룹
    assert set(p2["allowed_groups"]) == set(ALL_GROUPS)
    p3 = resolve_policy(["stories", "destructive"])
    assert p3["destructive_allowed"] is True


# ── 매니페스트 엔드포인트 ─────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_manifest_endpoint_returns_policy():
    from app.main import app
    from app.dependencies.auth import AuthContext, get_current_user
    from httpx import ASGITransport, AsyncClient

    async def override_auth():
        return AuthContext(
            user_id=str(uuid.uuid4()), email=None,
            claims={"app_metadata": {"api_key_id": "k", "scope": ["stories", "chat"]}},
            org_id=str(uuid.uuid4()),
        )

    app.dependency_overrides[get_current_user] = override_auth
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get("/api/v2/mcp/manifest")
            chk = await c.get("/api/v2/mcp/manifest/check?tool=sprintable_add_task")
        assert resp.status_code == 200
        body = resp.json()
        assert sorted(body["allowed_groups"]) == ["chat", "stories"]
        assert chk.json()["allowed"] is False  # tasks 그룹 미허용
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_manifest_requires_api_key():
    from app.main import app
    from app.dependencies.auth import AuthContext, get_current_user
    from httpx import ASGITransport, AsyncClient

    async def override_auth():
        return AuthContext(user_id=str(uuid.uuid4()), email=None,
                           claims={"app_metadata": {}}, org_id=None)  # JWT (api_key_id 없음)

    app.dependency_overrides[get_current_user] = override_auth
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get("/api/v2/mcp/manifest")
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()
