"""story #2428 PR④ — list_sprints·list_retro_sessions·list_artifacts·list_artifact_comments
MCP 도구 배선 mock 테스트. BE 축(X-Total-Count 실 total·body meta 실배선)은
test_2428_pr4_be_pagination_realdb.py가 커버 — 여기는 MCP 도구가 헤더/body-meta를 정확히
읽어 has_more/limit/cursor를 전달하는지만 mock으로 고정."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _headers(total: int, next_cursor: str | None = None) -> dict:
    h = {"x-total-count": str(total)}
    if next_cursor is not None:
        h["x-next-cursor"] = next_cursor
    return h


# ─── list_sprints (헤더 규약) ────────────────────────────────────────────────


@pytest.mark.anyio
async def test_list_sprints_signals_has_more():
    from sprintable_mcp.tools.sprints import ListSprintsInput, list_sprints

    items = [{"id": "s1"}]
    with patch("sprintable_mcp.tools.sprints.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get_with_headers = AsyncMock(return_value=(items, _headers(total=15, next_cursor="0:xyz")))
        out = await list_sprints(ListSprintsInput())

    parsed = json.loads(out[0].text)
    assert parsed == items
    assert len(out) == 2
    assert "0:xyz" in out[1].text


@pytest.mark.anyio
async def test_list_sprints_passes_limit_cursor_through():
    from sprintable_mcp.tools.sprints import ListSprintsInput, list_sprints

    with patch("sprintable_mcp.tools.sprints.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get_with_headers = AsyncMock(return_value=([], _headers(total=0)))
        await list_sprints(ListSprintsInput(limit=5, cursor="0:abc"))

    _, kwargs = mock_client.get_with_headers.call_args
    assert kwargs["params"]["limit"] == 5
    assert kwargs["params"]["cursor"] == "0:abc"


@pytest.mark.anyio
async def test_list_sprints_no_has_more_when_covered():
    from sprintable_mcp.tools.sprints import ListSprintsInput, list_sprints

    items = [{"id": "s1"}, {"id": "s2"}]
    with patch("sprintable_mcp.tools.sprints.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get_with_headers = AsyncMock(return_value=(items, _headers(total=2)))
        out = await list_sprints(ListSprintsInput())

    assert len(out) == 1


# ─── list_retro_sessions (헤더 규약) ─────────────────────────────────────────


@pytest.mark.anyio
async def test_list_retro_sessions_signals_has_more():
    from sprintable_mcp.tools.retro import ListRetroSessionsInput, list_retro_sessions

    items = [{"id": "r1"}]
    with patch("sprintable_mcp.tools.retro.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get_with_headers = AsyncMock(return_value=(items, _headers(total=6, next_cursor="0:xyz")))
        out = await list_retro_sessions(ListRetroSessionsInput())

    parsed = json.loads(out[0].text)
    assert parsed == items
    assert len(out) == 2
    assert "0:xyz" in out[1].text


@pytest.mark.anyio
async def test_list_retro_sessions_passes_limit_cursor_through():
    from sprintable_mcp.tools.retro import ListRetroSessionsInput, list_retro_sessions

    with patch("sprintable_mcp.tools.retro.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get_with_headers = AsyncMock(return_value=([], _headers(total=0)))
        await list_retro_sessions(ListRetroSessionsInput(limit=5, cursor="0:abc"))

    _, kwargs = mock_client.get_with_headers.call_args
    assert kwargs["params"]["limit"] == 5
    assert kwargs["params"]["cursor"] == "0:abc"


# ─── list_artifacts (body meta 규약) ─────────────────────────────────────────


@pytest.mark.anyio
async def test_list_artifacts_signals_has_more_from_body_meta():
    from sprintable_mcp.tools.visual_artifacts import ListArtifactsInput, list_artifacts

    shape = {"data": [{"id": "a1"}], "error": None, "meta": {"has_more": True, "next_cursor": "2026-08-17T00:00:00+00:00"}}
    with patch("sprintable_mcp.tools.visual_artifacts.client") as mock_client:
        mock_client.get = AsyncMock(return_value=shape)
        out = await list_artifacts(ListArtifactsInput())

    parsed = json.loads(out[0].text)
    assert parsed == shape["data"]
    assert len(out) == 2
    assert "2026-08-17T00:00:00+00:00" in out[1].text


@pytest.mark.anyio
async def test_list_artifacts_no_has_more_when_last_page():
    from sprintable_mcp.tools.visual_artifacts import ListArtifactsInput, list_artifacts

    shape = {"data": [{"id": "a1"}], "error": None, "meta": {"has_more": False, "next_cursor": None}}
    with patch("sprintable_mcp.tools.visual_artifacts.client") as mock_client:
        mock_client.get = AsyncMock(return_value=shape)
        out = await list_artifacts(ListArtifactsInput())

    assert len(out) == 1


@pytest.mark.anyio
async def test_list_artifacts_passes_limit_cursor_through():
    from sprintable_mcp.tools.visual_artifacts import ListArtifactsInput, list_artifacts

    shape = {"data": [], "error": None, "meta": {"has_more": False, "next_cursor": None}}
    with patch("sprintable_mcp.tools.visual_artifacts.client") as mock_client:
        mock_client.get = AsyncMock(return_value=shape)
        await list_artifacts(ListArtifactsInput(limit=5, cursor="2026-08-17T00:00:00+00:00"))

    _, kwargs = mock_client.get.call_args
    assert kwargs["params"]["limit"] == 5
    assert kwargs["params"]["cursor"] == "2026-08-17T00:00:00+00:00"


@pytest.mark.anyio
async def test_list_artifacts_bare_array_backcompat():
    """구 bare-array 응답(롤백/미갱신 BE)도 하위호환으로 통과 — meta 없으면 has_more=False."""
    from sprintable_mcp.tools.visual_artifacts import ListArtifactsInput, list_artifacts

    with patch("sprintable_mcp.tools.visual_artifacts.client") as mock_client:
        mock_client.get = AsyncMock(return_value=[{"id": "a1"}])
        out = await list_artifacts(ListArtifactsInput())

    parsed = json.loads(out[0].text)
    assert parsed == [{"id": "a1"}]
    assert len(out) == 1


# ─── list_artifact_comments (body meta 규약) ─────────────────────────────────


@pytest.mark.anyio
async def test_list_artifact_comments_signals_has_more_from_body_meta():
    from sprintable_mcp.tools.visual_artifacts import ListArtifactCommentsInput, list_artifact_comments

    shape = {"data": [{"id": "c1"}], "error": None, "meta": {"has_more": True, "next_cursor": "2026-08-17T00:00:00+00:00"}}
    with patch("sprintable_mcp.tools.visual_artifacts.client") as mock_client:
        mock_client.get = AsyncMock(return_value=shape)
        out = await list_artifact_comments(ListArtifactCommentsInput(artifact_id="art-1"))

    parsed = json.loads(out[0].text)
    assert parsed == shape["data"]
    assert len(out) == 2


@pytest.mark.anyio
async def test_list_artifact_comments_passes_limit_cursor_through():
    from sprintable_mcp.tools.visual_artifacts import ListArtifactCommentsInput, list_artifact_comments

    shape = {"data": [], "error": None, "meta": {"has_more": False, "next_cursor": None}}
    with patch("sprintable_mcp.tools.visual_artifacts.client") as mock_client:
        mock_client.get = AsyncMock(return_value=shape)
        await list_artifact_comments(ListArtifactCommentsInput(artifact_id="art-1", limit=5, cursor="2026-08-17T00:00:00+00:00"))

    args, kwargs = mock_client.get.call_args
    assert args[0] == "/api/v2/visual-artifacts/art-1/comments"
    assert kwargs["params"]["limit"] == 5
    assert kwargs["params"]["cursor"] == "2026-08-17T00:00:00+00:00"
