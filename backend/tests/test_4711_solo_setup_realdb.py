"""story 4711 — the first setup in three steps: `confirm-solo` makes ONE agent for the folder the person chose (real HTTP · migrated PG).

AC1/AC2 (the server half): no recipe, no story, nothing published; the agent is called by its program's name («Claude Code», a
name taken → «Claude Code 2»); the project is the one the app found for the folder (`project_id`) or a new one named after it
(a name taken → «{name} 2» — PO 03:36Z: two different `app` folders never share a project by name); the person ↔ agent DM is made
with it and its id comes back (the first screen is that conversation); the exchange hands the agent over as a made one (no
`existing`, no recipe name). Refusals leave nothing: an app that did not say «solo», an unknown runtime, both or neither project,
a person who is not an owner/admin, the plan's agent limit (402)."""
from __future__ import annotations

import uuid

import pytest

from tests.test_4565_attach_existing_agent_realdb import (  # noqa: F401 — fixtures used by name
    _live_keys,
    _plain_key,
    attachable,
)
from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures used by name
    EVENT_TOKENS,
    ORG,
    OWNER,
    PLAIN,
    PROJ,
    EXISTING,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _exchange,
    _person,
    _pkce,
    _quiet_stream_side_effects,
    _sql,
    anyio_backend,
    world,
)

_EXTRA_CLEAN = [
    f"DELETE FROM agent_api_keys WHERE team_member_id IN (SELECT id FROM members WHERE org_id='{ORG}')",
    f"DELETE FROM agent_project_profiles WHERE project_id IN (SELECT id FROM projects WHERE org_id='{ORG}')",
    f"DELETE FROM conversation_participants WHERE conversation_id IN (SELECT id FROM conversations WHERE org_id='{ORG}')",
    f"DELETE FROM conversations WHERE org_id='{ORG}'",
    f"DELETE FROM project_access WHERE project_id IN (SELECT id FROM projects WHERE org_id='{ORG}' AND id <> '{PROJ}')",
    f"DELETE FROM projects WHERE org_id='{ORG}' AND id <> '{PROJ}'",
]


@pytest.fixture
async def solo(attachable):  # 4565's world plus an agent of the organization that already runs somewhere
    yield
    await _sql(*_EXTRA_CLEAN)  # the projects a test made hang off project_access / profiles that the shared cleanup does not know


async def _solo_code(c, device: str, capabilities: list[str] | None = None) -> tuple[str, str, str]:
    verifier, challenge = _pkce()
    caps = ["solo"] if capabilities is None else capabilities
    r = await c.post("/api/v2/desktop/setup-codes", json={"challenge": challenge, "device_name": device, "capabilities": caps})
    assert r.status_code == 201, r.text
    EVENT_TOKENS[r.json()["setup_id"]] = r.json()["event_token"]
    return r.json()["code"], verifier, r.json()["setup_id"]


async def _confirm_solo(c, code: str, body: dict, who: uuid.UUID = OWNER):
    return await c.post("/api/v2/desktop/setup-codes/confirm-solo", json={"code": code, **body}, headers=_person(who))


async def _state() -> dict:
    rows = await _sql(fetch=(
        "SELECT "
        f"(SELECT count(*) FROM members WHERE org_id='{ORG}' AND type='agent'),"
        f"(SELECT count(*) FROM projects WHERE org_id='{ORG}'),"
        f"(SELECT count(*) FROM conversations WHERE org_id='{ORG}'),"
        f"(SELECT count(*) FROM stories WHERE project_id IN (SELECT id FROM projects WHERE org_id='{ORG}')),"
        f"(SELECT count(*) FROM recipe_role_bindings WHERE org_id='{ORG}')"
    ))
    agents, projects, rooms, stories, bindings = rows[0]
    return {"agents": agents, "projects": projects, "rooms": rooms, "stories": stories, "bindings": bindings}


@pytest.mark.anyio
async def test_a_solo_start_makes_one_agent_a_project_for_the_folder_and_the_room_to_open(solo):
    other_key = await _plain_key(EXISTING)  # an agent of the organization that runs somewhere else
    other_live = await _live_keys(EXISTING)
    async with _client() as c:
        before = await _state()
        code, verifier, setup_id = await _solo_code(c, "d4424 solo A")
        assert (await _sql(fetch=f"SELECT capabilities FROM desktop_setups WHERE id='{setup_id}'"))[0][0] == ["solo"]
        r = await _confirm_solo(c, code, {"runtime": "claude", "project_name": "my-app", "workdir_hint": "my-app"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["work_item_id"] is None if "work_item_id" in body else True
        (member,) = body["members"]
        assert (member["kind"], member["name"]) == ("agent", "Claude Code") and "stage" not in member
        after = await _state()
        # one agent · one project (the folder's) · one room — no story, no recipe binding
        assert after == {**before, "agents": before["agents"] + 1, "projects": before["projects"] + 1, "rooms": before["rooms"] + 1}
        proj = (await _sql(fetch=f"SELECT name FROM projects WHERE id='{body['project_id']}'"))[0][0]
        assert proj == "my-app"
        runtime = (await _sql(fetch=f"SELECT runtime_type FROM members WHERE id='{member['member_id']}'"))[0][0]
        assert runtime == "claude-code"  # the product's own spelling of the desktop runtime «claude»
        # the room: a DM of exactly the person and the new agent, in the project
        room = (await _sql(fetch=(
            f"SELECT c.type, c.project_id::text, (SELECT array_agg(p.member_id::text ORDER BY p.member_id::text) FROM conversation_participants p "
            f"WHERE p.conversation_id=c.id) FROM conversations c WHERE c.id='{body['conversation_id']}'"
        )))[0]
        assert room[0] == "dm" and room[1] == body["project_id"]
        assert len(room[2]) == 2 and member["member_id"] in room[2]

        # the status: «solo», no recipe, the room to open
        st = await c.get(f"/api/v2/desktop/setups/{setup_id}", headers=_person(OWNER))
        assert st.status_code == 200, st.text
        assert (st.json()["setup_kind"], st.json()["recipe"], st.json()["conversation_id"]) == ("solo", None, body["conversation_id"])
        listed = await c.get(f"/api/v2/desktop/setups?project_id={body['project_id']}", headers=_person(OWNER))
        assert {s["device_name"]: s["setup_kind"] for s in listed.json()["setups"]}["d4424 solo A"] == "solo"

        # confirming again (the same person, the same code) answers the same and makes nothing more
        again = await _confirm_solo(c, code, {"runtime": "claude", "project_name": "my-app"})
        assert (again.status_code, again.json()["conversation_id"], again.json()["project_id"]) == (200, body["conversation_id"], body["project_id"])
        assert await _state() == after

        # the exchange: a made agent (key made, not rotated) — no recipe name, no «existing», no role
        ex = await _exchange(c, code, verifier)
        assert ex.status_code == 200, ex.text
        out = ex.json()
        assert out["setup_kind"] == "solo" and "recipe_name" not in out and out["project_id"] == body["project_id"]
        mine = out["agents"][0]
        assert set(mine) == {"member_id", "runtime", "name", "api_key", "tools"}
        assert (mine["member_id"], mine["runtime"], mine["name"], mine["tools"]) == (member["member_id"], "claude", "Claude Code", [])
        assert (await c.get("/api/v2/auth/me", headers={"Authorization": f"Bearer {mine['api_key']}"})).status_code == 200
        # Kadir (5120): the exchange makes the solo agent's ONE key and rotates nobody else's — another agent's keys live on
        assert await _live_keys(EXISTING) == other_live
        assert (await c.get("/api/v2/auth/me", headers={"Authorization": f"Bearer {other_key}"})).status_code == 200
    assert (await _state())["stories"] == before["stories"]


@pytest.mark.anyio
async def test_the_folders_project_is_used_and_a_taken_name_gets_a_number(solo):
    async with _client() as c:
        before = await _state()
        # the app found that PROJ already uses the folder: no new project
        code, _, _ = await _solo_code(c, "d4424 solo B")
        r = await _confirm_solo(c, code, {"runtime": "codex", "project_id": str(PROJ)})
        assert r.status_code == 200, r.text
        assert r.json()["project_id"] == str(PROJ) and r.json()["members"][0]["name"] == "Codex"
        assert (await _state())["projects"] == before["projects"]
        # a second agent of the same program: «Claude Code 2» (the first one is «Claude Code»)
        names = []
        for i in range(2):
            code, _, _ = await _solo_code(c, f"d4424 solo C{i}")
            r = await _confirm_solo(c, code, {"runtime": "claude", "project_id": str(PROJ)})
            assert r.status_code == 200, r.text
            names.append(r.json()["members"][0]["name"])
        assert names == ["Claude Code", "Claude Code 2"]
        # PO 03:36Z: a project NAME that is taken is not the folder's project — a different `P` folder gets «P 2», then «P 3»
        made = []
        for i in range(2):
            code, _, _ = await _solo_code(c, f"d4424 solo D{i}")
            r = await _confirm_solo(c, code, {"runtime": "claude", "project_name": "P"})
            assert r.status_code == 200, r.text
            made.append((await _sql(fetch=f"SELECT name FROM projects WHERE id='{r.json()['project_id']}'"))[0][0])
        assert made == ["P 2", "P 3"]


@pytest.mark.anyio
async def test_solo_refusals_leave_nothing(solo):
    async with _client() as c:
        before = await _state()
        code, _, _ = await _solo_code(c, "d4424 solo refusals")
        cases = [
            ({"runtime": "vim", "project_name": "x"}, OWNER, (422, "roles_invalid")),
            ({"runtime": "claude"}, OWNER, (422, "request_invalid")),
            ({"runtime": "claude", "project_id": str(PROJ), "project_name": "x"}, OWNER, (422, "request_invalid")),
            ({"runtime": "claude", "project_name": "x"}, PLAIN, (403, "not_org_admin")),
            ({"runtime": "claude", "project_id": str(uuid.uuid4())}, OWNER, (404, None)),
        ]
        for body, who, want in cases:
            r = await _confirm_solo(c, code, body, who=who)
            got = (r.status_code, (r.json().get("error") or {}).get("code") if want[1] else None)
            assert got == want, (body, r.text)
        # an app from before (no «solo» said) is refused, and the same code still takes nothing
        for caps in ([], ["move"]):
            old, _, _ = await _solo_code(c, f"d4424 solo old {caps}", capabilities=caps)
            r = await _confirm_solo(c, old, {"runtime": "claude", "project_name": "x"})
            assert (r.status_code, r.json()["error"]["code"]) == (409, "app_cannot_solo"), r.text
        assert (await _sql(fetch="SELECT confirmed_at FROM desktop_setups WHERE device_name='d4424 solo refusals'"))[0][0] is None
        assert await _state() == before


@pytest.mark.anyio
async def test_the_plan_agent_limit_on_a_solo_start_leaves_no_project_agent_or_room(solo, monkeypatch):
    from sqlalchemy import text as sql_text

    from app.core.config import settings
    from ee import plan_limits

    async def limited(db, org_id):
        current = (await db.execute(sql_text(
            "SELECT COUNT(*) FROM members WHERE org_id = :oid AND type = 'agent' AND is_active = true AND deleted_at IS NULL"
        ), {"oid": str(org_id)})).scalar()
        if current >= 0:
            raise plan_limits._plan_limit_error("agent", 0, current=current, tier="free")

    monkeypatch.setattr(type(settings), "is_ee_enabled", property(lambda _self: True))
    monkeypatch.setattr("ee.plan_limits.check_agent_add_limit", limited)
    async with _client() as c:
        before = await _state()
        code, verifier, _ = await _solo_code(c, "d4424 solo limit")
        # a NEW project for the folder (made first), then the agent is refused: the project made on the way goes with it
        monkeypatch.setattr("app.services.org_project_create.check_project_create_allowed", _allow_project)
        r = await _confirm_solo(c, code, {"runtime": "claude", "project_name": "limit-app"})
        assert r.status_code == 402, r.text
        error = r.json()["error"]
        assert (error["code"], error.get("needed")) == ("PLAN_LIMIT_EXCEEDED", 1), r.text
        assert await _state() == before  # one transaction: no project, agent or room stayed
        assert (await _exchange(c, code, verifier)).status_code == 202  # the code still waits for a confirmation


async def _allow_project(_db, _org):
    return None


@pytest.mark.anyio
async def test_the_plan_project_limit_on_a_new_folder_is_the_plans_402_and_leaves_nothing(solo, monkeypatch):
    """The free plan holds one project: an organization that has it gets the plan's own 402 for a NEW folder project (the folder's
    project is a made one) — and a folder whose project the app found (`project_id`) still starts."""
    from app.core.config import settings

    async def agent_allowed(_db, _org):
        return None

    monkeypatch.setattr(type(settings), "is_ee_enabled", property(lambda _self: True))
    monkeypatch.setattr("ee.plan_limits.check_agent_add_limit", agent_allowed)  # this test is about the PROJECT limit
    async with _client() as c:
        before = await _state()
        code, _, _ = await _solo_code(c, "d4424 solo project limit")
        r = await _confirm_solo(c, code, {"runtime": "claude", "project_name": "second-folder"})
        assert r.status_code == 402, r.text
        error = r.json()["error"]
        assert (error["code"], error["resource"]) == ("PLAN_LIMIT_EXCEEDED", "project"), r.text
        # PO 03:55Z: the 402 names the organization's only project, so the card can ask «넣어 시작할까요?» — nothing is put there yet
        assert error["existing_project"] == {"id": str(PROJ), "name": "P"}, r.text
        assert await _state() == before
        # the person's [넣고 시작]: the same code, that project — the agent starts in it (the plan is not changed)
        ok = await _confirm_solo(c, code, {"runtime": "claude", "project_id": error["existing_project"]["id"]})
        assert ok.status_code == 200, ok.text
        assert ok.json()["project_id"] == str(PROJ)
        assert (await _state())["projects"] == before["projects"]
        # a second project in the organization: no single project to name, the plain 402 stays
        await _sql(f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES (gen_random_uuid(),'{ORG}','P2','d4711-p2','warn')")
        again, _, _ = await _solo_code(c, "d4424 solo project limit 2")
        r2 = await _confirm_solo(c, again, {"runtime": "claude", "project_name": "third-folder"})
        assert r2.status_code == 402 and "existing_project" not in r2.json()["error"], r2.text
