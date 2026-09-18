"""story 8b7e52d6(AC2) — add_story MCP 도구가 assignee_id 생략 시 warning 필드를 응답에
싣는지 고정. claim_story가 assignee를 절대 안 채운다(story 3414b6d7)는 걸 생성 시점에
알려 사후 수동 개입(story 0845cb03 실사례)을 줄인다."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_add_story_without_assignee_id_gets_warning():
    from sprintable_mcp.tools.stories import AddStoryInput, add_story

    be_response = {"id": "s1", "title": "Test Story", "reference_token": "[Test Story](entity:story:s1)"}

    with patch("sprintable_mcp.tools.stories.client") as mock_client:
        mock_client.require_project_id.return_value = "p1"
        mock_client.post = AsyncMock(return_value=be_response)
        out = await add_story(AddStoryInput(title="Test Story"))

    parsed = json.loads(out[0].text)
    assert "warning" in parsed
    assert "assignee" in parsed["warning"]
    # BE가 실제로 돌려준 필드는 그대로 보존(덮어쓰지 않음).
    assert parsed["id"] == "s1"
    assert parsed["reference_token"] == "[Test Story](entity:story:s1)"


@pytest.mark.anyio
async def test_add_story_with_assignee_id_no_warning():
    from sprintable_mcp.tools.stories import AddStoryInput, add_story

    be_response = {"id": "s1", "title": "Test Story", "assignee_id": "m1"}

    with patch("sprintable_mcp.tools.stories.client") as mock_client:
        mock_client.require_project_id.return_value = "p1"
        mock_client.post = AsyncMock(return_value=be_response)
        out = await add_story(AddStoryInput(title="Test Story", assignee_id="m1"))

    parsed = json.loads(out[0].text)
    assert "warning" not in parsed
