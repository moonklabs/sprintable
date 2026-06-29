"""b5870c4c: MCP list_backlog 이 존재하는 엔드포인트를 호출하는지 회귀 게이트.

버그: `sprintable_list_backlog` 가 `GET /api/v2/stories/backlog`(부재 라우트) 호출 → `/{id}` 로 shadow 돼
422(id="backlog" 非-UUID). fix(B): 기존 `GET /api/v2/stories` + `no_sprint`(server-side repo.list_backlog·
sprint 미배정·tool docstring 정합) 재사용. 신규 라우트 0.
"""
import pytest

from sprintable_mcp.tools import stories as st


@pytest.mark.anyio
async def test_list_backlog_targets_existing_endpoint_with_no_sprint(monkeypatch):
    captured: dict = {}

    class _FakeClient:
        project_id = "proj-1"
        org_id = None

        async def get(self, path, params=None):
            captured["path"] = path
            captured["params"] = params or {}
            return []

    monkeypatch.setattr(st, "client", _FakeClient())
    await st.list_backlog(None)

    # 부재 라우트(/stories/backlog) 호출 금지 — /{id} shadow→422 의 근본.
    assert captured["path"] == "/api/v2/stories", captured
    # no_sprint(+project_id)로 server-side backlog(sprint 미배정) 분기.
    assert captured["params"].get("no_sprint") == "true"
    assert captured["params"].get("project_id") == "proj-1"
