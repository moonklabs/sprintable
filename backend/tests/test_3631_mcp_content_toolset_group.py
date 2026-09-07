"""story #3631(2026-09-07, #3972에서 발견) — 콘텐츠/채널 도구 toolset 그룹 신설.

`sprintable_withdraw_channel_post_draft`(#3614, 이 도메인 첫 MCP 도구)가 `_GROUP_KEYWORDS`에
매칭 키워드가 없어 core로 분류됐다 — 콘텐츠 전용 그룹이 아예 없었다. story #2634(events 그룹
신설)와 동형 검증 관례를 따른다: 백엔드 SSOT(app/services/mcp_toolset.py)·vendored 사본
(sprintable_mcp/toolset.py) 양쪽 다 대조."""
from __future__ import annotations


def test_withdraw_channel_post_draft_classified_into_content_not_core():
    """실제 존재하는 유일한 콘텐츠 도구(#3614) — "channel_post" 키워드로 매칭."""
    from app.services.mcp_toolset import tool_group as backend_tool_group
    from sprintable_mcp.toolset import tool_group as vendored_tool_group

    assert backend_tool_group("sprintable_withdraw_channel_post_draft") == "content"
    assert vendored_tool_group("sprintable_withdraw_channel_post_draft") == "content"


# 아직 실재하지 않는 미래 도구명에도 키워드가 옳게 반응하는지(AC1의 전체 키워드 목록) —
# 합성 이름으로 검증(실제 등록 여부와 무관하게 분류 로직 자체를 고정).
_FUTURE_TOOL_NAMES_BY_KEYWORD = {
    "channel_post": "sprintable_create_channel_post_draft",
    "site_post": "sprintable_create_site_post_draft",
    "channel_connection": "sprintable_list_channel_connections",
    "post_comment": "sprintable_list_channel_post_comments",
    "insight": "sprintable_get_insight_snapshot",
}


def test_each_declared_keyword_classifies_into_content():
    from app.services.mcp_toolset import tool_group as backend_tool_group
    from sprintable_mcp.toolset import tool_group as vendored_tool_group

    for keyword, name in _FUTURE_TOOL_NAMES_BY_KEYWORD.items():
        assert backend_tool_group(name) == "content", f"{keyword} 키워드 매칭 실패: {name}"
        assert vendored_tool_group(name) == "content", f"{keyword} 키워드 매칭 실패(vendored): {name}"


def test_withdraw_alone_is_not_a_content_keyword():
    """의도적 제외(모듈 주석 참고) — "withdraw" 하나만으로는 content로 안 끌려온다. 미래의
    무관한 인출류 도구(예: 지갑/보상 인출)가 이 그룹으로 오분류되는 것을 막는다."""
    from app.services.mcp_toolset import tool_group as backend_tool_group

    assert backend_tool_group("sprintable_withdraw_wallet_balance") != "content"


def test_artifact_comment_tools_stay_in_canvas_not_content():
    """⭐음성대조 — "post_comment"(구체 키워드)를 썼지 바로 "comment"를 쓰지 않은 이유.
    sprintable_add_artifact_comment/list_artifact_comments는 "canvas" 그룹(story #2634
    이전부터 확립) 그대로여야 한다 — 새 content 그룹이 이 기존 분류를 가로채면 안 된다."""
    from app.services.mcp_toolset import tool_group as backend_tool_group
    from sprintable_mcp.toolset import tool_group as vendored_tool_group

    for name in ("sprintable_add_artifact_comment", "sprintable_list_artifact_comments"):
        assert backend_tool_group(name) == "canvas"
        assert vendored_tool_group(name) == "canvas"


def test_content_group_registered_in_all_groups_and_catalog_order():
    from app.services.mcp_toolset import ALL_GROUPS, _CATALOG_DISPLAY_ORDER

    assert "content" in ALL_GROUPS
    assert "content" in _CATALOG_DISPLAY_ORDER


def test_build_toolset_catalog_lists_content_group():
    """toolset-catalog(picker SSOT) 응답에 "content" 그룹이 서는지(AC2). 실 소속 도구 개수는
    #3614(sprintable_withdraw_channel_post_draft)의 병합 순서에 따라 이 워크트리 기준
    0개일 수도 1개일 수도 있어(두 PR이 develop에 독립적으로 올라간다) 개수 자체는 안 박고,
    그룹 존재·플래그·(있다면) 소속 도구가 전부 "content" 판정과 일치하는지만 고정한다."""
    from app.services.mcp_toolset import build_toolset_catalog, tool_group

    catalog = build_toolset_catalog()
    groups_by_key = {g["key"]: g for g in catalog["groups"]}
    assert "content" in groups_by_key
    content_group = groups_by_key["content"]
    assert content_group["is_core"] is False
    assert content_group["is_destructive"] is False
    for t in content_group["tools"]:
        assert tool_group(t) == "content"
