"""story #3614 CHANGES(2026-09-07, 페드루 PO 判定) — sprintable_withdraw_channel_post_draft를
_ALWAYS_ALLOWED에 임시 등재한 최초 처방이 반려됐다: 그 목록은 "scope 막론 항상 허용"(is_tool_
allowed 무조건 True) 의미라, 초안을 폐기하는 변이 도구를 두면 role scope가 없는 키도 호출
가능해지는 권한 확대였다(커버리지 공백을 권한으로 메운 지름길). 정공법 — 콘텐츠 전용 그룹을
`_GROUP_KEYWORDS`에 신설(이 스토리 범위는 이 한 도구, "channel_post" 키워드만 — 다른 콘텐츠
도구 키워드 확장은 story #3631). story #2634(events 그룹) 검증 관례를 그대로 따른다."""
from __future__ import annotations


def test_withdraw_tool_classified_into_content_group():
    from app.services.mcp_toolset import tool_group as backend_tool_group
    from sprintable_mcp.toolset import tool_group as vendored_tool_group

    assert backend_tool_group("sprintable_withdraw_channel_post_draft") == "content"
    assert vendored_tool_group("sprintable_withdraw_channel_post_draft") == "content"


def test_content_group_not_grantable_without_explicit_scope():
    """narrow(다른 그룹) scope로는 허용 안 됨 — _ALWAYS_ALLOWED가 아닌 진짜 그룹 경계."""
    from app.services.mcp_toolset import is_tool_allowed

    narrow_scope = ["stories", "tasks", "chat"]
    assert is_tool_allowed("sprintable_withdraw_channel_post_draft", narrow_scope) is False


def test_content_group_allowed_with_explicit_scope():
    from app.services.mcp_toolset import is_tool_allowed

    assert is_tool_allowed("sprintable_withdraw_channel_post_draft", ["content"]) is True


def test_content_group_allowed_with_legacy_or_empty_scope():
    """레거시(scope 미지정/read·write만)는 back-compat으로 전체 비파괴 허용 — content도 예외
    아님(is_tool_allowed 자체 계약, #2634 events와 동일 형)."""
    from app.services.mcp_toolset import is_tool_allowed

    assert is_tool_allowed("sprintable_withdraw_channel_post_draft", None) is True
    assert is_tool_allowed("sprintable_withdraw_channel_post_draft", []) is True
    assert is_tool_allowed("sprintable_withdraw_channel_post_draft", ["read", "write"]) is True


def test_content_group_registered_in_all_groups_and_catalog_order():
    from app.services.mcp_toolset import ALL_GROUPS, _CATALOG_DISPLAY_ORDER

    assert "content" in ALL_GROUPS
    assert "content" in _CATALOG_DISPLAY_ORDER


def test_channel_posts_rest_path_is_currently_unmapped_and_permissive():
    """PO 요청 — REST 경계(`_PATH_GROUP_PREFIXES`) 등재 시도 결과를 선언한다.

    channel_posts.py 라우터는 `/api/v2/organizations`(공유 prefix) 아래 `/{org_id}/
    channel-posts/...`형이라 — 이 리스트의 다른 모든 항목(`/api/v2/stories`처럼 독립
    top-level 자원)과 달리 org_id가 리터럴 prefix 사이에 끼어 있어 `path.startswith(prefix)`
    단순 매칭으로는 표현이 안 된다(신규 매칭 방식 없이는 `/api/v2/organizations` 전체를
    "content"로 묶어 다른 모든 org-scoped 자원까지 잘못 끌어오게 된다). 그래서 이 스토리는
    등재하지 않는다 — 결과: `channel-posts` REST 엔드포인트는 지금 `_PATH_GROUP_PREFIXES`
    미등록 → `path_to_tool_group()`가 None → `path_allowed_for_scope()`가 **scope 막론
    True**(story b4027b2e가 canvas 편입 前 visual-artifacts에서 겪은 것과 정확히 같은
    permissive-unmapped 폴백, 까심 라이브 실증 선례). 이 gap은 MCP 도구 쪽 그룹 경계
    (위 테스트들)와는 독립적 축이고, channel-posts 라우터가 애초에 이 REST 경계 자체를
    강제하는 의존성(get_verified_org_id)을 쓰는지와도 별개 문제 — 이 PR 범위 밖, 별건으로
    남긴다(story #3631 이후 후속 후보)."""
    from app.services.mcp_toolset import path_allowed_for_scope, path_to_tool_group

    withdraw_path = "/api/v2/organizations/org-1/channel-posts/drafts/draft-1/withdraw"
    assert path_to_tool_group(withdraw_path) is None
    assert path_allowed_for_scope(withdraw_path, ["stories"]) is True  # 무관 scope도 통과(gap)
    assert path_allowed_for_scope(withdraw_path, []) is True


def test_build_toolset_catalog_covers_withdraw_tool_in_content_group():
    """AC — 카탈로그 커버리지 공백이 해소됐는지 직접 확認(test_toolset_catalog.py의
    전체-커버리지 테스트와 별개로, 이 도구가 정확히 "content" 그룹에 들어있는지 명시 고정)."""
    from app.services.mcp_toolset import build_toolset_catalog

    catalog = build_toolset_catalog()
    groups_by_key = {g["key"]: g for g in catalog["groups"]}
    assert "content" in groups_by_key
    content_group = groups_by_key["content"]
    assert content_group["is_core"] is False
    assert content_group["is_destructive"] is False
    assert "sprintable_withdraw_channel_post_draft" in content_group["tools"]
    # core 그룹엔 더 이상 없어야 한다(반려된 _ALWAYS_ALLOWED 처방의 회귀 방지).
    assert "sprintable_withdraw_channel_post_draft" not in groups_by_key["core"]["tools"]
