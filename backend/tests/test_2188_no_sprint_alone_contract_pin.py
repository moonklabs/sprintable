"""story #2188 ④-b(2026-07-25, 오르테가군 판정) — «의도된 제약» 계약 pin. 코드 fix 아님.

`no_sprint=True`를 `project_id` 없이 보내면 backlog 분기(list_stories:123)가 안 걸려
제네릭 분기로 떨어지고, 거기엔 sprint_id IS NULL을 적용하는 로직이 없어 no_sprint가
통째로 무시된다 — 결함은 결함이나, 이 조합을 보낼 수 있는 살아있는 콜러가 구조적으로
없다(FE 타입·MCP 런타임 둘 다 project_id를 강제). "밟히지 않는 자리"를 코드로 고치기보다
계약으로 선언하고 pinning 테스트로 고정한다(#2188 board 분기의 ① ids 케이스와 동일 처신).
"""
from __future__ import annotations

import inspect

import pytest


def test_fe_backlog_repo_method_requires_project_id_non_optional():
    """FE ApiStoryRepository.backlog()가 projectId: string(non-optional)이라 no_sprint를
    project_id 없이 보내는 호출 자체가 TS 컴파일 타임에 존재할 수 없음을 소스로 고정."""
    import pathlib

    repo_ts = (
        pathlib.Path(__file__).resolve().parents[2]
        / "packages" / "storage-api" / "src" / "ApiStoryRepository.ts"
    )
    assert repo_ts.exists(), f"경로가 바뀌었으면 이 pin도 갱신 필요: {repo_ts}"
    source = repo_ts.read_text()
    assert "async backlog(projectId: string)" in source, (
        "backlog()의 projectId가 optional(projectId?: string)로 바뀌면 이 pin이 깨져야 하는 — "
        "그때는 no_sprint-단독 경로가 실제로 열릴 수 있다는 뜻이라 ④-b 판정을 재검토해야 한다"
    )


def test_mcp_list_backlog_tool_requires_project_id_at_runtime():
    """MCP list_backlog 툴이 client.require_project_id()로 런타임 강제하는지 소스로 고정."""
    from sprintable_mcp.tools import stories as st

    source = inspect.getsource(st.list_backlog)
    assert "require_project_id()" in source, (
        "list_backlog 툴이 require_project_id() 를 안 쓰게 바뀌면 no_sprint-단독 경로가 열릴 "
        "수 있다는 뜻이라 ④-b 판정을 재검토해야 한다"
    )


def test_no_sprint_alone_without_project_id_is_documented_noop():
    """소스 고정 — stories.py list_stories가 «의도된 제약»임을 문서화한 주석을 갖고 있는지.
    코드 동작 자체(no_sprint가 무시되는 것)를 고치는 게 아니라, 그게 의도라는 선언이
    소스에서 지워지지 않았는지만 지킨다."""
    import app.routers.stories as stories_module

    source = inspect.getsource(stories_module.list_stories)
    assert "④-b" in source and "의도된 제약" in source


@pytest.mark.anyio
async def test_actual_behavior_no_sprint_without_project_id_falls_through_to_generic():
    """실제 동작 확認(realdb 아님 — 순수 로직) — no_sprint=True인데 project_id=None이면
    backlog 분기 조건(:123 `if no_sprint and project_id`)이 거짓이 되어 제네릭 분기로
    떨어지는 것을 mock 세션으로 직접 확認. list_backlog()가 아예 호출 안 되는 것이 핵심."""
    from unittest.mock import AsyncMock, MagicMock

    from app.dependencies.auth import AuthContext
    from app.routers.stories import list_stories

    repo = MagicMock()
    repo.org_id = "org-1"
    repo.session = MagicMock()
    repo.list_backlog = AsyncMock(side_effect=AssertionError("backlog 분기가 호출되면 안 됨"))
    repo.list = AsyncMock(return_value=[])

    async def _noop(*args, **kwargs):
        return None

    import app.routers.stories as stories_module
    orig_assignee = stories_module._attach_assignee_ids
    orig_evidence = stories_module._attach_has_evidence
    stories_module._attach_assignee_ids = _noop
    stories_module._attach_has_evidence = _noop
    try:
        auth = AuthContext(user_id="agent-1", email=None, claims={"app_metadata": {}})
        result = await list_stories(
            project_id=None, epic_id=None, sprint_id=None, assignee_id=None,
            status_filter=None, no_sprint=True, ids=None, story_number=None, q=None,
            limit=1000, cursor=None, response=None, repo=repo, auth=auth,
            # story #2532: 신규 Query 파라미터 — sentinel lint(scripts/lint_query_sentinel_
            # direct_calls.py) baseline과 missing-set을 맞추기 위해 명시.
            unattached=False,
        )
        assert result == []
        repo.list.assert_awaited_once()
        repo.list_backlog.assert_not_awaited()
    finally:
        stories_module._attach_assignee_ids = orig_assignee
        stories_module._attach_has_evidence = orig_evidence
