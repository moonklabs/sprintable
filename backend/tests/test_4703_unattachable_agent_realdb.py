"""story 4703 — the server side of «the recruiter's agent cannot be attached» (PO 10-15: not only the web stops it).

The web never sends `agent=` (an address value of the setup page) — the server sees only the confirmation's rows. So two things must hold
here, on a real database, for every agent the confirming person may NOT attach (another organization's · an id nobody has · one with no
desktop runtime · an inactive one · one outside the project):
- ②: the refused confirmation makes nothing — no new agent (the row beside it that asks for a new one included), no story, no stage
   binding, no published event, the setup stays unconfirmed. A refused attach never falls through to «a new agent instead».
- ③: another organization's agent and an id that exists nowhere get THE SAME answer — status and the whole body — and the answer does
   not repeat the id that was asked (whether it exists elsewhere never shows).
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures used by name
    ORG,
    OWNER,
    PROJ,
    _addresses,
    _client,
    _code,
    _confirm,
    _dispose_global_engine_after_test,
    _quiet_stream_side_effects,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4565_attach_existing_agent_realdb import (  # noqa: F401 — fixtures used by name
    INACTIVE,
    NO_RUNTIME,
    NOT_IN_PROJECT,
    OTHER_ORG_AGENT,
    _attach,
    attachable,
)
from tests.test_4576_move_setup_realdb import _move, _move_code, _project_state, movable  # noqa: F401

pytestmark = pytest.mark.anyio

# every agent the confirming person may not attach, with the answer the server gives
UNATTACHABLE = {
    "another organization's agent": (OTHER_ORG_AGENT, 404, "agent_not_found"),
    "an id nobody has": (uuid.UUID("d4703000-0000-0000-0000-0000000000aa"), 404, "agent_not_found"),
    "an agent with no desktop runtime": (NO_RUNTIME, 404, "agent_not_found"),
    "an inactive agent": (INACTIVE, 404, "agent_not_found"),
    "an agent outside the project": (NOT_IN_PROJECT, 422, "agent_not_in_project"),
}


async def _everything_a_confirmation_may_make() -> dict:
    """Members (agents included), the project's stories / stage bindings / published events, and the confirmed setups."""
    state = await _project_state()
    state["members"] = (await _sql(fetch=f"SELECT count(*) FROM members WHERE org_id='{ORG}'"))[0][0]
    state["agents"] = (await _sql(fetch=f"SELECT count(*) FROM members WHERE org_id='{ORG}' AND type='agent'"))[0][0]
    state["confirmed"] = (await _sql(fetch=f"SELECT count(*) FROM desktop_setups WHERE org_id='{ORG}' AND confirmed_at IS NOT NULL"))[0][0]
    return state


@pytest.mark.parametrize("why", list(UNATTACHABLE))
async def test_a_refused_attach_makes_no_new_agent_story_binding_or_event(movable, why):
    agent_id, status, code = UNATTACHABLE[why]
    async with _client() as c:
        before = await _everything_a_confirmation_may_make()
        # a recipe confirmation: the unattachable agent for one role AND a NEW agent (codex) for the other — the new one must not appear
        recipe_code, _ = await _code(c, f"d4703 recipe {why}")
        r = await _confirm(c, recipe_code, body=_attach(agent_id))
        assert (r.status_code, r.json()["error"]["code"]) == (status, code), r.text
        assert await _everything_a_confirmation_may_make() == before, f"a recipe confirmation refused for {why} left something behind"

        # a move: the same agent alone — refused, nothing made
        move_code, _verifier, _setup = await _move_code(c, f"d4703 move {why}")
        r = await _confirm(c, move_code, body=_move(agent_id))
        assert (r.status_code, r.json()["error"]["code"]) == (status, code), r.text
        assert await _everything_a_confirmation_may_make() == before, f"a move refused for {why} left something behind"


async def test_another_orgs_agent_and_an_id_nobody_has_get_the_same_answer_whole(movable):
    foreign, nobody = OTHER_ORG_AGENT, UNATTACHABLE["an id nobody has"][0]
    async with _client() as c:
        answers = {}
        for name, agent_id in (("foreign", foreign), ("nobody", nobody)):
            recipe_code, _ = await _code(c, f"d4703 same {name} recipe")
            move_code, _v, _s = await _move_code(c, f"d4703 same {name} move")
            recipe = await _confirm(c, recipe_code, body=_attach(agent_id))
            move = await _confirm(c, move_code, body=_move(agent_id))
            # the id that was asked never comes back in the answer
            assert str(agent_id) not in recipe.text and str(agent_id) not in move.text
            answers[name] = (recipe.status_code, recipe.json(), move.status_code, move.json())
    assert answers["foreign"] == answers["nobody"], "another organization's agent answered differently from an id nobody has"
    assert answers["foreign"][0] == 404 and answers["foreign"][1]["error"]["code"] == "agent_not_found"
    # …and an agent with no desktop runtime or an inactive one reads the same too (nothing tells «exists» from «does not»)
    async with _client() as c:
        for agent_id in (NO_RUNTIME, INACTIVE):
            recipe_code, _ = await _code(c, f"d4703 same {agent_id} recipe")
            r = await _confirm(c, recipe_code, body=_attach(agent_id))
            assert (r.status_code, r.json()) == (answers["foreign"][0], answers["foreign"][1]), agent_id


async def _statements_of_one_refusal(c, agent_id: uuid.UUID, kind: str) -> list[str]:
    """The SQL statements the server ran for ONE refused confirmation (the confirmation only — the code is made before listening)."""
    from sqlalchemy import event

    from app.core.database import engine

    if kind == "recipe":
        code, _ = await _code(c, f"d4703 sql recipe {agent_id}")
        body = _attach(agent_id)
    else:
        code, _v, _s = await _move_code(c, f"d4703 sql move {agent_id}")
        body = _move(agent_id)
    seen: list[str] = []

    def listener(conn, cursor, statement, parameters, context, executemany):  # noqa: ANN001
        seen.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", listener)
    try:
        r = await _confirm(c, code, body=body)
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", listener)
    assert r.status_code == 404 and r.json()["error"]["code"] == "agent_not_found", r.text
    return seen


@pytest.mark.parametrize("kind", ["recipe", "move"])
async def test_the_refusal_costs_the_server_the_same_work_for_another_orgs_agent_and_an_id_nobody_has(movable, kind):
    # PO 10-15 ③ (Kadir: «시간차 포함»): not only the same answer — the same WORK. A wall-clock comparison is flaky, so this pins the
    # deterministic part: the same SQL statements in the same order for another organization's agent, an id nobody has, an agent with no
    # desktop runtime and an inactive one. A server that went and looked «elsewhere» for the foreign id would run an extra statement.
    async with _client() as c:
        await _statements_of_one_refusal(c, OTHER_ORG_AGENT, kind)  # warm-up: first-use work (caches · lazy imports) is not the thing measured
        foreign = await _statements_of_one_refusal(c, OTHER_ORG_AGENT, kind)
        nobody = await _statements_of_one_refusal(c, UNATTACHABLE["an id nobody has"][0], kind)
        no_runtime = await _statements_of_one_refusal(c, NO_RUNTIME, kind)
        inactive = await _statements_of_one_refusal(c, INACTIVE, kind)
    assert foreign, "the listener saw nothing — the measurement is broken"
    assert foreign == nobody == no_runtime == inactive


async def test_the_candidates_list_never_carries_another_orgs_agent_and_asks_for_no_id(attachable):
    # the list is this organization's agents only, and has no «look this id up» parameter — the web cannot learn «exists elsewhere» from it
    async with _client() as c:
        r = await c.get(f"/api/v2/desktop/setup/agents?project_id={PROJ}&agent_id={OTHER_ORG_AGENT}", headers=_person_owner())
        assert r.status_code == 200, r.text
        ids = {a["id"] for a in r.json()["agents"]}
        assert str(OTHER_ORG_AGENT) not in ids
        plain = await c.get(f"/api/v2/desktop/setup/agents?project_id={PROJ}", headers=_person_owner())
        assert plain.json() == r.json(), "an `agent_id` parameter changed the list — the list must not answer for a single id"


def _person_owner() -> dict:
    from tests.test_4424_desktop_setup_realdb import _person

    return _person(OWNER)
