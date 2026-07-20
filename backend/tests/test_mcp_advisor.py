"""P0 Harness-local Advisor MCP contract tests.

These tests intentionally exercise the MCP boundary rather than the local
model: Sprintable owns the context and claim recording, while the client owns
model execution and must never be allowed to choose its agent identity.
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock

import pytest

from app.services.mcp_toolset import is_tool_allowed, path_allowed_for_scope, path_to_tool_group, tool_group
from sprintable_mcp.api_client import client
from sprintable_mcp.tools.advisor import AdvisorContextInput, ReportDoneInput, advisor_context, report_done


@pytest.fixture
def restore_member_id():
    previous = client._member_id
    try:
        yield
    finally:
        client._member_id = previous


@pytest.mark.anyio
async def test_advisor_context_forwards_get_query_without_mutation(monkeypatch):
    get = AsyncMock(return_value={"schema_version": 1})
    post = AsyncMock()
    monkeypatch.setattr(client, "get", get)
    monkeypatch.setattr(client, "post", post)

    result = await advisor_context(AdvisorContextInput(
        story_id="story-1", moment="kickoff", max_prior_decisions=2,
    ))

    get.assert_awaited_once_with(
        "/api/v2/advisor/context",
        params={"story_id": "story-1", "moment": "kickoff", "max_prior_decisions": 2},
    )
    post.assert_not_awaited()
    assert json.loads(result[0].text) == {"schema_version": 1}


@pytest.mark.anyio
async def test_report_done_injects_client_member_id_and_never_accepts_agent_id(monkeypatch, restore_member_id):
    client._member_id = "canonical-agent-id"
    post = AsyncMock(return_value={"completed_stage": "merge"})
    monkeypatch.setattr(client, "post", post)

    result = await report_done(ReportDoneInput(
        story_id="story-1", stage="merge", summary="implemented",
        self_review={"schema_version": 1, "mode": "local", "verdict": "likely_pass"},
    ))

    post.assert_awaited_once_with("/api/v2/workflow/report-done", json={
        "story_id": "story-1", "stage": "merge", "agent_id": "canonical-agent-id",
        "summary": "implemented",
        "self_review": {"schema_version": 1, "mode": "local", "verdict": "likely_pass"},
    })
    assert "agent_id" not in ReportDoneInput.model_json_schema()["properties"]
    assert "org_id" not in ReportDoneInput.model_json_schema()["properties"]
    assert json.loads(result[0].text)["completed_stage"] == "merge"


@pytest.mark.anyio
async def test_report_done_requires_member_identity_before_post(monkeypatch, restore_member_id):
    client._member_id = ""
    post = AsyncMock()
    monkeypatch.setattr(client, "post", post)

    result = await report_done(ReportDoneInput(story_id="story-1", stage="merge"))

    post.assert_not_awaited()
    assert result[0].text.startswith("Error: MCP member identity is required")


def test_advisor_tools_are_stories_scoped_not_core_or_always_allowed():
    for name in ("sprintable_advisor_context", "sprintable_report_done"):
        assert tool_group(name) == "stories"
        assert is_tool_allowed(name, ["stories"])
        assert is_tool_allowed(name, ["read", "write"])
        assert not is_tool_allowed(name, ["tasks"])

    assert path_to_tool_group("/api/v2/advisor/context") == "stories"
    assert path_to_tool_group("/api/v2/workflow/report-done") == "stories"
    assert path_allowed_for_scope("/api/v2/advisor/context", ["stories"])
    assert not path_allowed_for_scope("/api/v2/advisor/context", ["tasks"])
    assert not path_allowed_for_scope("/api/v2/workflow/report-done", ["tasks"])
