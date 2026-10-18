"""story 4680 AC2 — the role an agent was hired for reaches the daemon (and so the session): `GET /api/v2/agent-run-profile` with the agent's own key gains `persona`.

Only that agent's own default persona; for a recruited one (it carries its job template's id) the SESSION edition — the role + the operating rules + the workflow pointer,
not the tool table and never the recruit's one-time «reflect this into your memory» instruction; a hand-written persona as it is; no persona → the field is not there at all.
Real HTTP over a migrated PG.
"""
from __future__ import annotations

import json
import uuid

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    OWNER,
    PROJ,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device

pytestmark = pytest.mark.anyio

OWN = "/api/v2/agent-run-profile"
PROJ_B = uuid.UUID("d4680000-0000-0000-0000-0000000000b2")
TEMPLATE = uuid.UUID("d4680000-0000-0000-0000-0000000000c1")


@pytest.fixture(autouse=True)
async def _clean_what_this_file_seeds():
    """the job template is a GLOBAL catalog row and the personas hang on no foreign key — nothing here may outlive its test (another test counts the catalog)"""
    yield
    await _sql(
        f"DELETE FROM agent_personas WHERE org_id IN ('{ORG}', 'd4680000-0000-0000-0000-0000000000f0')",
        f"DELETE FROM role_templates WHERE id = '{TEMPLATE}'",
    )


def _key(device, i=0) -> dict:
    return {"Authorization": f"Bearer {device['agents'][i]['api_key']}", "X-Org-Id": str(ORG)}


async def _template(slug: str = "d4680-bug-triage") -> None:
    await _sql(
        "INSERT INTO role_templates (id, slug, name, category, role_behaviors, role_behaviors_i18n, default_tool_groups, runtime_overrides, is_builtin, is_published, tier, version) "
        f"VALUES ('{TEMPLATE}', '{slug}', 'Bug Triage Lead', 'engineering', 'Triage every new bug: severity first, then an owner.', "
        "'{\"en\": \"EN: Triage every new bug: severity first, then an owner.\"}'::jsonb, ARRAY['stories','tasks'], '{}'::jsonb, false, true, 'free', 1) ON CONFLICT (id) DO NOTHING"
    )


async def _persona(agent, *, name="Bug Triage Lead", system_prompt="", style=None, config: dict | None = None, project=PROJ, default=True, builtin=False, deleted=False, org=ORG) -> uuid.UUID:
    pid = uuid.uuid4()
    q = lambda v: "NULL" if v is None else "'" + str(v).replace("'", "''") + "'"  # noqa: E731
    await _sql(
        "INSERT INTO agent_personas (id, org_id, project_id, agent_id, name, slug, system_prompt, style_prompt, config, is_builtin, is_default, deleted_at) VALUES "
        f"('{pid}', '{org}', '{project}', '{agent}', {q(name)}, 'p-{pid.hex[:8]}', {q(system_prompt)}, {q(style)}, '{json.dumps(config or {})}'::jsonb, {str(builtin).lower()}, {str(default).lower()}, "
        f"{'now()' if deleted else 'NULL'})"
    )
    return pid


def _recruit_text(locale: str = "ko") -> str:
    from types import SimpleNamespace

    from app.services.agent_recruiter import compose_kit

    tpl = SimpleNamespace(
        name="Bug Triage Lead", role_behaviors="Triage every new bug: severity first, then an owner.",
        role_behaviors_i18n={"en": "EN: Triage every new bug: severity first, then an owner."}, default_tool_groups=["stories", "tasks"], runtime_overrides={}, skills=[],
    )
    return "\n\n".join(compose_kit(tpl, "claude-code", locale).values())


async def test_01_an_agent_that_was_never_hired_as_a_role_gets_no_persona_field(world):
    async with _client() as c:
        device = await _device(c, name="d4680 mac a")
        own = await c.get(OWN, headers=_key(device))
        assert own.status_code == 200, own.text
        assert "persona" not in own.json()


async def test_02_a_recruited_persona_hands_over_the_session_edition_only(world):
    from app.services.agent_recruiter import _AGILE_OPERATING_RULES, _INTEGRATION_PROMPT_TEXT, _tool_cheat_sheet

    await _template()
    async with _client() as c:
        device = await _device(c, name="d4680 mac b")
        agent = device["agents"][0]["member_id"]
        full = _recruit_text("ko")
        assert _INTEGRATION_PROMPT_TEXT["ko"].split("\n", 1)[0] in full           # the recruit's text DOES carry the one-time instruction …
        await _persona(agent, system_prompt=full, config={"role_template_id": str(TEMPLATE), "tool_allowlist": ["stories"]})
        own = await c.get(OWN, headers=_key(device))
        persona = own.json()["persona"]
        assert persona["role"] == "Bug Triage Lead"                                 # the job template's name (members.agent_role stays empty for a recruited agent)
        text = persona["instructions"]
        assert "Bug Triage Lead" in text and "Triage every new bug: severity first, then an owner." in text     # the role
        assert _AGILE_OPERATING_RULES["ko"].strip()[:40] in text                    # the operating rules
        assert _INTEGRATION_PROMPT_TEXT["ko"].split("\n", 1)[0] not in text         # … the session does NOT
        assert "메모리" not in text.split("sprintable_get_workflow_guide")[-1]
        assert _tool_cheat_sheet(["stories", "tasks"], "ko").split("\n", 1)[0] not in text   # no tool table (the MCP connection names the tools)
        assert len(persona["version"]) == 16 and persona["style"] is None


async def test_03_the_english_kit_gives_the_english_session_edition(world):
    from app.services.agent_recruiter import _INTEGRATION_PROMPT_TEXT

    await _template()
    async with _client() as c:
        device = await _device(c, name="d4680 mac c")
        agent = device["agents"][0]["member_id"]
        await _persona(agent, system_prompt=_recruit_text("en"), config={"role_template_id": str(TEMPLATE)})
        text = (await c.get(OWN, headers=_key(device))).json()["persona"]["instructions"]
        assert "EN: Triage every new bug" in text and "Sprintable Role Context" in text
        assert _INTEGRATION_PROMPT_TEXT["en"].split("\n", 1)[0] not in text


async def test_04_a_hand_written_persona_goes_as_it_is_and_a_gone_template_falls_back_to_the_text_minus_the_integration_prompt(world):
    from app.services.agent_recruiter import _INTEGRATION_PROMPT_TEXT

    async with _client() as c:
        device = await _device(c, name="d4680 mac d")
        agent, other = device["agents"][0]["member_id"], device["agents"][1]["member_id"]
        await _persona(agent, name="Release Captain", system_prompt="You decide when we ship.\nAlways ask QA first.", style="Short sentences.")
        mine = (await c.get(OWN, headers=_key(device))).json()["persona"]
        assert (mine["role"], mine["instructions"], mine["style"]) == ("Release Captain", "You decide when we ship.\nAlways ask QA first.", "Short sentences.")
        # a recruited persona whose template is gone: its own text, without the integration prompt
        await _persona(other, system_prompt=_recruit_text("ko"), config={"role_template_id": str(uuid.uuid4())})
        gone = (await c.get(OWN, headers=_key(device, 1))).json()["persona"]
        assert _INTEGRATION_PROMPT_TEXT["ko"].split("\n", 1)[0] not in gone["instructions"] and "Bug Triage Lead" in gone["instructions"]


async def test_05_only_the_agents_own_default_persona_in_its_org(world):
    async with _client() as c:
        device = await _device(c, name="d4680 mac e")
        agent, other = device["agents"][0]["member_id"], device["agents"][1]["member_id"]
        await _persona(other, name="The Other One", system_prompt="not yours")                       # another agent's
        await _persona(agent, name="Not default", system_prompt="x", default=False)                     # not the default
        p = lambda n: uuid.UUID(f"d4680000-0000-0000-0000-0000000000{n}")  # noqa: E731 — one project each (one default per project and agent)
        await _persona(agent, name="A built-in", system_prompt="x", builtin=True, project=p("d1"))      # a built-in
        await _persona(agent, name="Deleted", system_prompt="x", deleted=True, project=p("d2"))         # deleted
        await _persona(agent, name="Other org", system_prompt="x", project=p("d3"), org=uuid.UUID("d4680000-0000-0000-0000-0000000000f0"))   # another organization's row
        assert "persona" not in (await c.get(OWN, headers=_key(device))).json()
        theirs = (await c.get(OWN, headers=_key(device, 1))).json()["persona"]
        assert theirs["role"] == "The Other One"
        assert (await c.get(OWN, headers=_person(OWNER))).status_code == 403                            # a person is not a daemon


async def test_06_the_project_of_the_start_picks_its_persona_else_the_earliest(world):
    async with _client() as c:
        device = await _device(c, name="d4680 mac f")
        agent = device["agents"][0]["member_id"]
        await _persona(agent, name="In project A", system_prompt="a", project=PROJ)
        await _persona(agent, name="In project B", system_prompt="b", project=PROJ_B)
        assert (await c.get(OWN, headers=_key(device))).json()["persona"]["role"] == "In project A"                        # the earliest
        assert (await c.get(OWN, params={"project_id": str(PROJ_B)}, headers=_key(device))).json()["persona"]["role"] == "In project B"
        assert (await c.get(OWN, params={"project_id": str(uuid.uuid4())}, headers=_key(device))).json()["persona"]["role"] == "In project A"   # none there → the earliest


async def test_07_the_text_is_capped_by_characters_and_bytes_and_control_and_format_characters_are_gone(world):
    async with _client() as c:
        device = await _device(c, name="d4680 mac g")
        agent = device["agents"][0]["member_id"]
        hidden = "\u202e\u2066\u200b\u200f\ufeff\u2028\u2029\u2060"
        await _persona(agent, name="Cap\x07tain\nof\u202e  the ship", system_prompt="line one\r\nline\x01 two\ttab\x1b[31m" + hidden + "end" + "x" * 20_000)
        p = (await c.get(OWN, headers=_key(device))).json()["persona"]
        assert p["role"] == "Captain of the ship"                                   # one line · same filter
        assert p["instructions"].startswith("line one\nline two\ttab[31mend") and len(p["instructions"]) == 16_000
        assert not any(ch in p["instructions"] for ch in ("\x01", "\x07", "\x1b", "\r") + tuple(hidden))
        # bytes: 16,000 Korean characters would be 48 KB — the byte cap cuts first
        await _sql(f"UPDATE agent_personas SET system_prompt = '{'가' * 16_000}' WHERE agent_id = '{agent}'")
        k = (await c.get(OWN, headers=_key(device))).json()["persona"]["instructions"]
        assert len(k.encode("utf-8")) <= 32_000 and len(k) == 10_666


async def test_07b_the_base_persona_goes_through_the_same_filter_and_the_one_cap(world):
    async with _client() as c:
        device = await _device(c, name="d4680 mac i")
        agent = device["agents"][0]["member_id"]
        base = await _persona(agent, name="House style", system_prompt="BASE\u202e text\x01 here", style="base\u200bstyle", default=False)
        await _persona(agent, name="Captain", system_prompt="own text", style="own style", config={"base_persona_id": str(base)})
        p = (await c.get(OWN, headers=_key(device))).json()["persona"]
        assert p["instructions"] == "BASE text here\n\nown text"                      # base first, cleaned, same text as the persona's own
        assert p["style"] == "basestyle\n\nown style"
        await _sql(f"UPDATE agent_personas SET system_prompt = '{'b' * 20_000}' WHERE id = '{base}'")
        long = (await c.get(OWN, headers=_key(device))).json()["persona"]["instructions"]
        assert len(long) == 16_000 and long.startswith("b" * 100)                    # base + own never beyond one cap


async def test_08_the_version_is_a_digest_of_what_is_handed_and_moves_when_it_changes(world):
    async with _client() as c:
        device = await _device(c, name="d4680 mac h")
        agent = device["agents"][0]["member_id"]
        pid = await _persona(agent, name="Captain", system_prompt="first text")
        v1 = (await c.get(OWN, headers=_key(device))).json()["persona"]["version"]
        assert v1 == (await c.get(OWN, headers=_key(device))).json()["persona"]["version"]
        await _sql(f"UPDATE agent_personas SET system_prompt = 'second text' WHERE id = '{pid}'")
        v2 = (await c.get(OWN, headers=_key(device))).json()["persona"]["version"]
        assert v2 != v1 and "text" not in v2
