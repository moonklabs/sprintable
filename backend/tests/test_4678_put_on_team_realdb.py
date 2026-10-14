"""story 4678 (UX-1 · P1′-a) — the server half of the setup page's «프로젝트 팀에 넣기», on a real database.

The web (apps/web/src/components/desktop/desktop-setup.tsx `putOnTeam`) does exactly this, and counts on three server answers nothing else pinned:
  1. `POST /api/v2/projects/{id}/access {member_id, org_member_id: null, permission: 'granted'}` makes the agent a member of the team
     — and a second press answers **409** (the web treats 409 as «already on the team» = success, so the 409 must stay a 409);
  2. after it, `GET /api/v2/desktop/setup/agents?project_id=…` marks that agent `in_project: true` (the page re-reads this list — it never guesses);
  3. the setup code that is open meanwhile is not touched (the person does not lose the code on the way), and [시작] (the confirmation)
     that was refused with `agent_not_in_project` before the grant now takes the agent.

Plus the refusals the web's one generic failure line stands for: a plain member (403) · another organization's / a stopped agent (400).
Measured against the real routes with the real alembic-built schema (the 4424/4565 harness) — not the dev server (no session in the lane).
"""
from __future__ import annotations

import json

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures used by name
    ORG,
    OWNER,
    PLAIN,
    PROJ,
    _addresses,
    _client,
    _code,
    _confirm,
    _dispose_global_engine_after_test,
    _person,
    _quiet_stream_side_effects,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4565_attach_existing_agent_realdb import (  # noqa: F401 — the fixture and ids used by name
    INACTIVE,
    NOT_IN_PROJECT,
    OTHER_ORG_AGENT,
    _attach,
    attachable,
)

_GRANT = {"org_member_id": None, "permission": "granted"}


async def _list(c, who=OWNER) -> dict:
    r = await c.get(f"/api/v2/desktop/setup/agents?project_id={PROJ}", headers=_person(who))
    assert r.status_code == 200, r.text
    return {a["id"]: a for a in r.json()["agents"]}


async def _grant(c, member, who=OWNER):
    return await c.post(f"/api/v2/projects/{PROJ}/access", json={**_GRANT, "member_id": str(member)}, headers=_person(who))


async def _grants(member) -> int:
    return (await _sql(fetch=f"SELECT count(*) FROM project_access WHERE project_id='{PROJ}' AND member_id='{member}'"))[0][0]


async def _setup_row(device: str) -> str:
    """The whole row of the open setup code, as JSON — the grant must leave it exactly as it was."""
    rows = await _sql(fetch=f"SELECT row_to_json(s)::text FROM desktop_setups s WHERE device_name='{device}'")
    assert len(rows) == 1
    return rows[0][0]


@pytest.mark.anyio
async def test_put_on_team_flow_as_the_page_runs_it(attachable):
    device = "d4678 put-on-team"
    async with _client() as c:
        # the page's list: the outsider is there, marked off-team
        before = await _list(c)
        assert before[str(NOT_IN_PROJECT)]["in_project"] is False

        # the same outsider is refused at [시작] today — the dead end the button removes
        spare_code, _ = await _code(c, "d4678 spare")
        r = await _confirm(c, spare_code, body=_attach(NOT_IN_PROJECT))
        assert (r.status_code, r.json()["error"]["code"]) == (422, "agent_not_in_project")

        # the code the person came with is open; the grant must not touch it
        code, _verifier = await _code(c, device)
        row_before = await _setup_row(device)

        # [프로젝트 팀에 넣기] — one POST
        r = await _grant(c, NOT_IN_PROJECT)
        assert r.status_code in (200, 201), r.text
        assert await _grants(NOT_IN_PROJECT) == 1

        # the page re-reads the list: now it can be chosen; nothing else changed
        after = await _list(c)
        assert after[str(NOT_IN_PROJECT)]["in_project"] is True
        assert set(after) == set(before)
        assert {k: v["in_project"] for k, v in after.items() if k != str(NOT_IN_PROJECT)} == {
            k: v["in_project"] for k, v in before.items() if k != str(NOT_IN_PROJECT)
        }

        # a second press (or the person added it on another screen): 409 — the web counts that as «on the team»
        r = await _grant(c, NOT_IN_PROJECT)
        assert r.status_code == 409, r.text
        assert "already exists" in json.dumps(r.json()).lower()
        assert await _grants(NOT_IN_PROJECT) == 1  # no second record
        assert (await _list(c))[str(NOT_IN_PROJECT)]["in_project"] is True

        # the open code is exactly as it was — and [시작] now takes the agent
        assert await _setup_row(device) == row_before
        r = await _confirm(c, code, body=_attach(NOT_IN_PROJECT))
        assert r.status_code == 200, r.text
        writer = next(m for m in r.json()["members"] if m["stage"] == "writer")
        assert (writer["member_id"], writer["kind"]) == (str(NOT_IN_PROJECT), "agent")


@pytest.mark.anyio
async def test_the_refusals_the_one_failure_line_stands_for(attachable):
    async with _client() as c:
        # a plain member of the organization (not an admin) cannot put anyone on the team
        r = await _grant(c, NOT_IN_PROJECT, who=PLAIN)
        assert r.status_code == 403, r.text
        assert await _grants(NOT_IN_PROJECT) == 0

        # another organization's agent and a stopped agent are 400 «must be an active agent in the project's org» — nothing is written
        for agent in (OTHER_ORG_AGENT, INACTIVE):
            r = await _grant(c, agent)
            assert r.status_code == 400, (agent, r.text)
            assert await _grants(agent) == 0

        # a body that names no one / two (the page always names exactly one agent) is 422
        r = await c.post(f"/api/v2/projects/{PROJ}/access", json={**_GRANT, "member_id": None}, headers=_person(OWNER))
        assert r.status_code == 422, r.text

        # and none of those moved the list
        assert (await _list(c))[str(NOT_IN_PROJECT)]["in_project"] is False
