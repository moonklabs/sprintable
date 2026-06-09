"""E-MCP S3: 로컬 MCP 부팅 시 허용 toolset만 노출 (S2 매니페스트 기반 boot 필터).

S2 wrapper(call-time 차단)는 유지, S3는 list/schema에서 허용 밖 도구 제거(컨텍스트 절감).
매니페스트 fetch 실패 시 None → 레거시 비파괴셋으로 degrade(crash 금지).
"""
import sprintable_mcp.server as server


def test_disallowed_tools_explicit_group():
    d = server.disallowed_tools(["stories"])
    assert "sprintable_add_task" in d        # tasks 그룹 미허용 → 제거 대상
    assert "sprintable_add_story" not in d    # stories 허용 → 노출
    assert "sprintable_send_chat_message" in d  # chat 미허용


def test_disallowed_tools_legacy_keeps_nondestructive_hides_destructive():
    d = server.disallowed_tools(["read", "write"])
    assert "sprintable_add_story" not in d     # 비파괴 → 노출
    assert "sprintable_delete_story" in d       # destructive → 숨김(grant 없음)
    assert "sprintable_give_reward" in d


def test_disallowed_tools_none_fallback_equals_legacy():
    """매니페스트 fetch 실패(None) = 레거시 비파괴셋(destructive만 숨김)."""
    d = server.disallowed_tools(None)
    assert "sprintable_add_story" not in d
    assert "sprintable_delete_story" in d


def test_ping_never_in_disallowed():
    # ping은 _TOOL_DEFS 밖 항상-노출 도구 → 어떤 scope에서도 제거 대상 아님
    for scope in (["stories"], None, [], ["read"]):
        assert "sprintable_ping" not in server.disallowed_tools(scope)
        assert "ping" not in server.disallowed_tools(scope)


def test_filter_tools_by_scope_removes_disallowed(monkeypatch):
    removed: list[str] = []
    monkeypatch.setattr(server.mcp, "remove_tool", lambda name: removed.append(name))
    n = server.filter_tools_by_scope(["stories"])
    assert n == len(removed) > 0
    assert "sprintable_add_task" in removed       # 제거됨
    assert "sprintable_add_story" not in removed   # 보존
    assert "sprintable_ping" not in removed        # 항상 노출


def test_filter_fallback_none_hides_only_destructive(monkeypatch):
    removed: list[str] = []
    monkeypatch.setattr(server.mcp, "remove_tool", lambda name: removed.append(name))
    server.filter_tools_by_scope(None)  # degrade
    assert "sprintable_delete_story" in removed     # destructive 숨김
    assert "sprintable_add_story" not in removed     # 비파괴 보존
