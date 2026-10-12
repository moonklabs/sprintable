# story 4653 (PO 14015 · 17027): the tool names an agent carries — ONE rule (lowercase, 1–24 characters), no repeat, the runtime
# never among them, at most 8 in all; a request name off the rule is refused (422) and named; the exchange keeps each agent's own.
import pytest
from pydantic import ValidationError

from app.routers.desktop_setup import RoleIn
from app.services.desktop_setup import AGENT_TOOL_NAME_MAX, AGENT_TOOLS_CAP, bind_setup_roles, clean_agent_tools, group_exchange_agents, RoleChoice


def test_one_rule_is_1_to_24_lowercase_characters():
    assert AGENT_TOOL_NAME_MAX == 24
    assert clean_agent_tools(["a", "x" * 24]) == ["a", "x" * 24]
    assert clean_agent_tools(["x" * 25, "AWS", "a b", "1aws", "aws/x", ""]) == []


def test_the_runtime_is_never_kept_among_the_tools():
    assert clean_agent_tools(["claude", "gcloud", "codex"], "claude") == ["gcloud", "codex"]


def test_no_repeat_and_at_most_the_cap():
    assert clean_agent_tools(["gcloud", "gcloud", "gh"]) == ["gcloud", "gh"]
    assert len(clean_agent_tools([f"t{i:02d}" for i in range(AGENT_TOOLS_CAP + 5)])) == AGENT_TOOLS_CAP


def test_a_request_name_off_the_rule_is_refused_naming_it():
    with pytest.raises(ValidationError) as e:
        RoleIn(role="pm", runtime="claude", tools=["gcloud", "AWS"])
    assert "AWS" in str(e.value)


def test_a_request_within_the_rule_is_accepted_and_a_list_over_the_cap_is_refused():
    assert RoleIn(role="pm", runtime="claude", tools=["gcloud"]).tools == ["gcloud"]
    with pytest.raises(ValidationError):
        RoleIn(role="pm", runtime="claude", tools=[f"t{i:02d}" for i in range(AGENT_TOOLS_CAP + 1)])


def test_the_binder_keeps_each_agent_roles_tools_without_the_runtime():
    rows = [{"role": "pm", "kind": "agent", "stages": ["s1"]}, {"role": "dev", "kind": "agent", "stages": ["s2"]}]
    roles = [RoleChoice(role="pm", runtime="claude", tools=["claude", "gcloud"]), RoleChoice(role="dev", runtime="codex")]
    assert bind_setup_roles(rows, roles).agent_tools == {"pm": ["claude", "gcloud"]}


def test_the_exchange_keeps_each_agent_its_own_tools_and_unions_a_recipe_agents_rows():
    members = [
        {"stage": "s1", "role": "pm", "member_id": "A", "kind": "agent", "runtime": "claude", "tools": ["gcloud"]},
        {"stage": "s2", "role": "pm", "member_id": "A", "kind": "agent", "runtime": "claude", "tools": ["gcloud", "gh"]},
        {"stage": "s3", "role": "dev", "member_id": "B", "kind": "agent", "runtime": "codex", "tools": ["aws"]},
        {"stage": "s4", "role": "qa", "member_id": "H", "kind": "human", "runtime": None, "tools": ["gh"]},
    ]
    per = group_exchange_agents(members, "recipe")
    assert per["A"]["tools"] == ["gcloud", "gh"]
    assert per["B"]["tools"] == ["aws"]
    assert "H" not in per


def test_a_move_agent_keeps_its_own_tools_in_the_exchange():
    members = [{"member_id": "A", "kind": "agent", "runtime": "claude", "tools": ["gcloud"]}, {"member_id": "B", "kind": "agent", "runtime": "codex", "tools": ["aws"]}]
    per = group_exchange_agents(members, "move")
    assert per["A"]["tools"] == ["gcloud"] and per["B"]["tools"] == ["aws"]


def test_a_name_ending_in_a_newline_or_padded_is_refused_not_trimmed():
    # Python's `$` accepts a trailing newline: the rule is the whole original text, nothing trimmed (PO 17028 ②)
    assert clean_agent_tools(["aws\n", " aws", "gh\t"]) == []
    with pytest.raises(ValidationError) as e:
        RoleIn(role="pm", runtime="claude", tools=["aws\n"])
    assert "aws" in str(e.value)
