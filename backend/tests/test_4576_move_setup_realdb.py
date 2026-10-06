"""story #4576 — «옮기기»: agents the organization already has move to a computer with no recipe (real HTTP · migrated PG).

The defect (positive control first, AC1): a recipe confirmation upserts the project's one recipe-stage binding row per stage, so
attaching agent A and then agent B under the same recipe routes A's stage work to B, and each confirmation makes a sample story
and publishes its first stage. AC2: a move — no recipe_id, every row `{role, agent_id}` of an existing agent — is the device and
its keys only: no binding written, no story, nothing published; the keys rotate at the exchange as for any attached agent
(4565 AC2). AC4 refusals: a new-agent or «me» row in a move, no agent, the same agent twice, another org's agent, one not in the
project, a person who is not an owner/admin, a move without a project. The status and the list say `flow` and carry names.
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures used by name
    EVENT_TOKENS,
    EXISTING,
    ORG,
    OWNER,
    PLAIN,
    PROJ,
    RECIPE,
    RECIPE_KEY,
    _addresses,
    _client,
    _code,
    _confirm,
    _pkce,
    _dispose_global_engine_after_test,
    _exchange,
    _person,
    _quiet_stream_side_effects,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4565_attach_existing_agent_realdb import (  # noqa: F401 — fixtures used by name
    NOT_IN_PROJECT,
    OTHER_ORG_AGENT,
    _live_keys,
    _plain_key,
    attachable,
)

EXISTING_B = uuid.UUID("d4576000-0000-0000-0000-000000000001")


@pytest.fixture
async def movable(attachable):
    """A second existing agent (codex) in the project, beside 4565's EXISTING (claude)."""
    await _sql(
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active,runtime_type) VALUES ('{EXISTING_B}','{ORG}',NULL,'agent','  Second   one ',true,'codex')",
        f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES (gen_random_uuid(),'{PROJ}','{EXISTING_B}','granted')",
    )
    yield


async def _move_code(c, device: str, capabilities: list[str] | None = None) -> tuple[str, str, str]:
    """A code as an app that can take a move asks for it (PO 04:24Z: `capabilities: ["move"]`)."""
    verifier, challenge = _pkce()
    caps = capabilities if capabilities is not None else ["move"]
    r = await c.post("/api/v2/desktop/setup-codes", json={"challenge": challenge, "device_name": device, "capabilities": caps})
    assert r.status_code == 201, r.text
    EVENT_TOKENS[r.json()["setup_id"]] = r.json()["event_token"]
    return r.json()["code"], verifier, r.json()["setup_id"]


def _move(*agent_ids: uuid.UUID) -> dict:
    return {"project_id": str(PROJ), "roles": [{"role": "Agent", "agent_id": str(a)} for a in agent_ids]}


def _recipe_attach(agent_id: uuid.UUID) -> dict:
    return {"project_id": str(PROJ), "recipe_id": str(RECIPE), "roles": [{"role": "Writer", "agent_id": str(agent_id)}, {"role": "Reviewer", "runtime": "codex"}]}


async def _project_state() -> dict:
    """What a confirmation may leave in the project: its recipe-stage bindings, its stories, the stage events published."""
    bindings = sorted(await _sql(fetch=(
        f"SELECT event_definition_key, stage, agent_member_id::text FROM recipe_role_bindings WHERE org_id='{ORG}' AND project_id='{PROJ}'"
    )))
    stories = (await _sql(fetch=f"SELECT count(*) FROM stories WHERE project_id='{PROJ}'"))[0][0]
    published = (await _sql(fetch=(
        "SELECT count(*) FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id "
        f"WHERE c.org_id='{ORG}' AND m.metadata->'event'->'payload'->>'stage' IS NOT NULL"
    )))[0][0]
    return {"bindings": bindings, "stories": stories, "published": published}


@pytest.mark.anyio
async def test_positive_control_a_recipe_confirmation_rebinds_the_stage_to_the_last_agent_and_makes_a_sample_story(movable):
    """AC1 (the defect, kept for «레시피로 시작»): A then B attached under the same recipe — the writer stage ends bound to B."""
    async with _client() as c:
        before = await _project_state()
        for agent in (EXISTING, EXISTING_B):
            code, _ = await _code(c, f"d4576 recipe {agent}")
            r = await _confirm(c, code, body=_recipe_attach(agent))
            assert r.status_code == 200, r.text
            assert r.json()["work_item_id"]
        after = await _project_state()
    writer = [b for b in after["bindings"] if b[:2] == (RECIPE_KEY, "writer")]
    assert writer == [(RECIPE_KEY, "writer", str(EXISTING_B))]  # A's stage now routes to B
    assert after["stories"] == before["stories"] + 2
    assert after["published"] > before["published"]


@pytest.mark.anyio
async def test_a_move_is_the_device_and_its_keys_only(movable):
    old_a, old_b = await _plain_key(EXISTING), await _plain_key(EXISTING_B)
    async with _client() as c:
        before = await _project_state()
        code_a, verifier_a, setup_a_id = await _move_code(c, "d4576 move A")
        assert (await _sql(fetch=f"SELECT capabilities FROM desktop_setups WHERE id='{setup_a_id}'"))[0][0] == ["move"]
        r = await _confirm(c, code_a, body=_move(EXISTING))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["work_item_id"] is None
        # PO 04:24Z: a move's agent is its id and its own name — no stage, no recipe role
        assert body["members"] == [{"member_id": str(EXISTING), "kind": "agent", "name": "Existing"}]
        code_b, _, _ = await _move_code(c, "d4576 move B")
        r = await _confirm(c, code_b, body=_move(EXISTING_B))
        assert r.status_code == 200, r.text
        assert r.json()["members"][0]["name"] == "Second one"  # spaces folded
        # nothing of either move reached the project: no binding, no story, nothing published
        assert await _project_state() == before
        # confirming again (the same person, the same code) answers the same, still nothing made
        again = await _confirm(c, code_a, body=_move(EXISTING))
        assert (again.status_code, again.json()["work_item_id"]) == (200, None)
        assert await _project_state() == before

        setup_a = (await _sql(fetch="SELECT id, event_definition_key, work_item_id FROM desktop_setups WHERE device_name='d4576 move A'"))[0]
        assert setup_a[1:] == (None, None)
        st = await c.get(f"/api/v2/desktop/setups/{setup_a[0]}", headers=_person(OWNER))
        assert st.status_code == 200, st.text
        assert (st.json()["setup_kind"], st.json()["recipe"], st.json()["work_item_id"]) == ("move", None, None)
        # PO 04:33Z: the status's move rows carry the runtime too (the progress line «{name} · {runtime}»)
        assert {k: st.json()["members"][0][k] for k in ("name", "stage", "runtime")} == {"name": "Existing", "stage": None, "runtime": "claude"}
        listed = await c.get(f"/api/v2/desktop/setups?project_id={PROJ}", headers=_person(OWNER))
        assert listed.status_code == 200, listed.text
        kinds = {s["device_name"]: s["setup_kind"] for s in listed.json()["setups"]}
        assert kinds["d4576 move A"] == "move"

        # the exchange: the agent's old key ends, its new one works — as for any attached agent (4565 AC2)
        assert await _live_keys(EXISTING) == 2  # the fixture's and the old launcher's — nothing revoked at the confirmation
        r = await _exchange(c, code_a, verifier_a)
        assert r.status_code == 200, r.text
        ex = r.json()
        assert ex["setup_kind"] == "move" and "recipe_name" not in ex  # PO 04:24Z: a move has no recipe name at all
        mine = ex["agents"][0]
        assert set(mine) == {"member_id", "runtime", "existing", "name", "api_key"}  # no role, no stages
        assert (mine["member_id"], mine["existing"], mine["runtime"], mine["name"]) == (str(EXISTING), True, "claude", "Existing")
        assert await _live_keys(EXISTING) == 1
        assert (await c.get("/api/v2/auth/me", headers={"Authorization": f"Bearer {old_a}"})).status_code == 401
        assert (await c.get("/api/v2/auth/me", headers={"Authorization": f"Bearer {mine['api_key']}"})).status_code == 200
        # B was confirmed, not exchanged: its old key still works
        assert (await c.get("/api/v2/auth/me", headers={"Authorization": f"Bearer {old_b}"})).status_code != 401
    assert await _project_state() == before


@pytest.mark.anyio
async def test_a_move_refuses_with_closed_codes_and_leaves_nothing(movable):
    async with _client() as c:
        before = await _project_state()
        code, _, _ = await _move_code(c, "d4576 refusals")
        cases = [
            ({**_move(EXISTING), "roles": [{"role": "Agent", "runtime": "claude"}]}, (422, "move_needs_existing_agents")),
            ({**_move(EXISTING), "roles": [{"role": "Agent", "owner": "me"}]}, (422, "move_needs_existing_agents")),
            ({**_move(EXISTING), "roles": [{"role": "Agent", "agent_id": str(EXISTING)}, {"role": "B", "runtime": "codex"}]}, (422, "move_needs_existing_agents")),
            ({**_move(EXISTING), "roles": []}, (422, "move_needs_existing_agents")),
            (_move(EXISTING, EXISTING), (422, "roles_invalid")),
            ({**_move(EXISTING), "roles": [{"role": "Agent", "agent_id": "not-a-uuid"}]}, (422, "roles_invalid")),
            (_move(OTHER_ORG_AGENT), (404, "agent_not_found")),
            (_move(uuid.uuid4()), (404, "agent_not_found")),
            (_move(NOT_IN_PROJECT), (422, "agent_not_in_project")),
            ({"project_name": "d4576 new", "roles": [{"role": "Agent", "agent_id": str(EXISTING)}]}, (422, "request_invalid")),
        ]
        for body, want in cases:
            r = await _confirm(c, code, body=body)
            assert (r.status_code, r.json()["error"]["code"]) == want, (body, r.text)
        r = await _confirm(c, code, who=PLAIN, body=_move(EXISTING))
        assert (r.status_code, r.json()["error"]["code"]) == (403, "not_org_admin")
    assert (await _sql(fetch="SELECT confirmed_at FROM desktop_setups WHERE device_name='d4576 refusals'"))[0][0] is None
    assert await _project_state() == before


@pytest.mark.anyio
async def test_an_app_that_did_not_say_it_can_move_gets_no_move(movable):
    """PO 04:24Z — an app from before reads a move's exchange as malformed: a code with no «move» capability is refused a move
    (app_cannot_move · 409), and the same code still takes a recipe confirmation as before."""
    async with _client() as c:
        for caps in ([], ["something-new"]):
            code, _, setup_id = await _move_code(c, f"d4576 old app {caps}", capabilities=caps)
            assert (await _sql(fetch=f"SELECT capabilities FROM desktop_setups WHERE id='{setup_id}'"))[0][0] is None
            r = await _confirm(c, code, body=_move(EXISTING))
            assert (r.status_code, r.json()["error"]["code"]) == (409, "app_cannot_move"), r.text
        r = await _confirm(c, code, body=_recipe_attach(EXISTING))
        assert r.status_code == 200, r.text


@pytest.mark.anyio
async def test_a_move_takes_no_first_task_step_and_a_recipe_setup_still_does(movable):
    async with _client() as c:
        code, _, move_id = await _move_code(c, "d4576 step move")
        assert (await _confirm(c, code, body=_move(EXISTING))).status_code == 200
        step = {"event": "desktop_first_task_handed", "session_id": move_id, "meta": {"via": "start"}}
        r = await c.post("/api/v2/onboarding/events", json=step, headers={"X-Setup-Event-Token": EVENT_TOKENS[move_id]})
        assert (r.status_code, r.json()["error"]["code"]) == (409, "not_for_move"), r.text
        code_r, _ = await _code(c, "d4576 step recipe")
        rr = await _confirm(c, code_r, body=_recipe_attach(EXISTING_B))
        assert rr.status_code == 200, rr.text
        recipe_id = str((await _sql(fetch="SELECT id FROM desktop_setups WHERE device_name='d4576 step recipe'"))[0][0])
        r = await c.post("/api/v2/onboarding/events", json={**step, "session_id": recipe_id}, headers={"X-Setup-Event-Token": EVENT_TOKENS[recipe_id]})
        assert r.status_code == 202, r.text
    assert (await _sql(fetch=f"SELECT count(*) FROM onboarding_events WHERE session_id='{move_id}' AND event='desktop_first_task_handed'"))[0][0] == 0
