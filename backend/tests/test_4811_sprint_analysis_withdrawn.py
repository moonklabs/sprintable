"""story 4811 (OPEN-ZERO ⑧, PR-S) — the agent surface of the sprint no longer has its analysis and write tools, and the server no longer has the four analysis routes.

What stays (a person on the web screen uses it): list, create, edit, activate, close, transition, kick-off of a sprint, and `velocity-history` until the performance panel (4808) stops calling it.
What goes: the MCP tools sprint_summary · activate_sprint · close_sprint · get_velocity · create_sprint · update_sprint · get_sprint_velocity_history · checkin_sprint, and the routes
GET /sprints/{id}/burndown · /velocity · /summary · /checkin.

Each test below goes red if the withdrawn thing is put back (the registry / the route tree is read, not a copy of it)."""
from __future__ import annotations

import os

os.environ.setdefault("SPRINTABLE_API_URL", "http://test")
os.environ.setdefault("AGENT_API_KEY", "sk_test")

from app.main import app  # noqa: E402
from app.services.mcp_toolset import ALL_TOOL_NAMES  # noqa: E402
from sprintable_mcp.server import mcp  # noqa: E402

WITHDRAWN_TOOLS = {
    "sprintable_sprint_summary", "sprintable_activate_sprint", "sprintable_close_sprint", "sprintable_get_velocity",
    "sprintable_create_sprint", "sprintable_update_sprint", "sprintable_get_sprint_velocity_history", "sprintable_checkin_sprint",
}
KEPT_SPRINT_TOOLS = {
    "sprintable_list_sprints", "sprintable_assign_story_to_sprint", "sprintable_unassign_story_from_sprint", "sprintable_list_backlog",
}
WITHDRAWN_ROUTES = {
    "/api/v2/sprints/{sprint_id}/burndown", "/api/v2/sprints/{sprint_id}/velocity",
    "/api/v2/sprints/{id}/summary", "/api/v2/sprints/{id}/checkin",
}
KEPT_ROUTES = {
    ("/api/v2/sprints", "get"), ("/api/v2/sprints", "post"),
    ("/api/v2/sprints/{id}", "get"), ("/api/v2/sprints/{id}", "patch"), ("/api/v2/sprints/{id}", "delete"),
    ("/api/v2/sprints/{id}/activate", "post"), ("/api/v2/sprints/{id}/close", "post"),
    ("/api/v2/sprints/{id}/transition", "post"), ("/api/v2/sprints/{id}/kickoff", "post"),
    ("/api/v2/analytics/velocity-history", "get"),
}


def test_the_eight_sprint_tools_are_not_registered():
    registered = set(mcp._tool_manager._tools)
    assert not (WITHDRAWN_TOOLS & registered), sorted(WITHDRAWN_TOOLS & registered)


def test_the_four_sprint_tools_that_stay_are_registered():
    assert KEPT_SPRINT_TOOLS <= set(mcp._tool_manager._tools)


def test_the_backend_toolset_catalog_agrees_with_the_registry():
    # the backend owns the tool-name list the scope picker reads; a withdrawn name left there would be offered for a tool that does not exist
    assert not (WITHDRAWN_TOOLS & set(ALL_TOOL_NAMES)), sorted(WITHDRAWN_TOOLS & set(ALL_TOOL_NAMES))


def test_the_seed_text_allowance_never_hides_a_live_tool():
    # tests/withdrawn_tool_names.py lets withdrawn names stay in old migration seed text; none of them may be a registered tool
    from tests.withdrawn_tool_names import WITHDRAWN_BUT_STILL_IN_SEED_TEXT

    registered = set(mcp._tool_manager._tools)
    assert not (WITHDRAWN_BUT_STILL_IN_SEED_TEXT & registered), sorted(WITHDRAWN_BUT_STILL_IN_SEED_TEXT & registered)
    assert WITHDRAWN_TOOLS <= WITHDRAWN_BUT_STILL_IN_SEED_TEXT


def test_the_four_analysis_routes_are_gone_from_the_route_tree():
    paths = set(app.openapi()["paths"])
    assert not (WITHDRAWN_ROUTES & paths), sorted(WITHDRAWN_ROUTES & paths)


def test_the_sprint_routes_the_web_screen_uses_are_still_there():
    paths = app.openapi()["paths"]
    missing = [(p, m) for p, m in sorted(KEPT_ROUTES) if m not in paths.get(p, {})]
    assert not missing, missing
