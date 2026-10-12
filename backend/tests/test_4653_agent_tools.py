# story 4653 (PO 14015 (가)-a): the tool names a setup's agent carries are cleaned before they reach the app — names only, short,
# lowercase, no duplicates, capped. Pure: no database.
from app.services.desktop_setup import AGENT_TOOLS_CAP, clean_agent_tools


def test_plain_names_pass_in_order_without_duplicates():
    assert clean_agent_tools(["gcloud", "aws", "gcloud"]) == ["gcloud", "aws"]


def test_anything_that_is_not_a_short_plain_name_is_dropped():
    raw = ["aws", "AWS", "a b", "/usr/bin/gh", "../x", "", "x", "y" * 40, 7, None, {"name": "gh"}, "vercel-cli"]
    assert clean_agent_tools(raw) == ["aws", "vercel-cli"]


def test_not_a_list_gives_nothing():
    assert clean_agent_tools(None) == []
    assert clean_agent_tools("gcloud") == []
    assert clean_agent_tools({"gcloud": True}) == []


def test_the_list_is_capped():
    raw = [f"tool{i:02d}" for i in range(AGENT_TOOLS_CAP + 5)]
    assert len(clean_agent_tools(raw)) == AGENT_TOOLS_CAP
