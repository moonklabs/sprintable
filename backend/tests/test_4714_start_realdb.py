"""story #4714 (UX-1 · 폰) — a phone's signed start of an agent on a paired computer for one project. Design 4714-design.md · contract 02d2cf71
(new version). The server opens no signature and makes no folder: it checks who may press, the computer, the pairing and shows only
what the computer said it has a folder for (ids, never a path); the computer re-reads its own files and refuses what it cannot do.
Each test goes red without the line it names (mutants in the PR body).
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    ORG2,
    OWNER,
    OWNER_TM,
    PLAIN,
    PROJ,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device, _tok
from tests.test_4533_agent_permissions_realdb import _pair, _plain_member, _register
from tests.test_4534_desktop_commands_realdb import _commands, _remote_control_on, _state  # noqa: F401

pytestmark = pytest.mark.anyio

PROJ2 = uuid.UUID("d4424000-0000-0000-0000-0000000000a2")  # a second project of the agent — the person has no access to it
PROJ3 = uuid.UUID("d4424000-0000-0000-0000-0000000000a3")  # a project the agent is NOT in


@pytest.fixture(autouse=True)
async def _more_projects(world):
    await _sql(
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES ('{PROJ2}','{ORG}','Other project','d4714-p2','warn') ON CONFLICT DO NOTHING",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES ('{PROJ3}','{ORG}','Unrelated project','d4714-p3','warn') ON CONFLICT DO NOTHING",
    )
    yield
    await _sql(f"DELETE FROM agent_project_profiles WHERE project_id IN ('{PROJ2}','{PROJ3}')",
               f"DELETE FROM project_access WHERE project_id IN ('{PROJ2}','{PROJ3}')",
               f"DELETE FROM projects WHERE id IN ('{PROJ2}','{PROJ3}')")


async def _setup(c, name):
    """A device of the owner's with the owner's phone paired; the device reports that it can start the first agent in PROJ and PROJ2."""
    device = await _device(c, name=name)
    agent = device["agents"][0]["member_id"]
    await _state(c, device, agent, "idle", 1)
    phone, der = await _register(c)
    await _pair(c, device["device_token"], der)
    await _sql(f"INSERT INTO agent_project_profiles (id,member_id,project_id) VALUES (gen_random_uuid(),'{agent}','{PROJ2}')")
    return device, agent, phone, der


def _startable(*pairs):
    return {"startable": [{"agent_member_id": a, "project_id": str(p)} for a, p in pairs]}


def _start(phone, setup_id, project=PROJ, key=None, **extra):
    return {"setup_id": setup_id, "project_id": str(project), "idempotency_key": key or str(uuid.uuid4()),
            "signed": "eyJ2IjoxfQ.signed-by-the-phone", "phone_key_id": phone, **extra}


def _post(c, agent, body, who=OWNER, headers=None):
    return c.post(f"/api/v2/agents/{agent}/desktop-start", json=body, headers=headers or _person(who))


def _list(c, agent, phone, who=OWNER):
    return c.get(f"/api/v2/agents/{agent}/desktop-startable", params={"phone_key_id": phone}, headers=_person(who))


async def test_01_the_computer_reports_ids_only_the_list_is_replaced_whole_and_a_stranger_agent_or_a_path_is_refused(world):
    async with _client() as c:
        device, agent, _phone, _der = await _setup(c, "d4424 mac 4714a")
        sid, tok = device["setup_id"], _tok(device["device_token"])
        # no device token → 401 (a person is no device)
        assert (await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ)), headers=_person(OWNER))).status_code == 401
        ok = await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ), (agent, PROJ2), (agent, PROJ), (agent, PROJ3)), headers=tok)
        assert (ok.status_code, ok.json()) == (200, {"startable": 2})  # sorted · no repeat · (agent, PROJ3) dropped: the agent is not in that project
        stored = (await _sql(fetch=f"SELECT startable FROM desktop_setups WHERE id = '{sid}'"))[0][0]
        assert sorted(stored, key=lambda i: i["project_id"]) == [{"agent_member_id": agent, "project_id": str(PROJ)}, {"agent_member_id": agent, "project_id": str(PROJ2)}]
        # narrowed to what the agents can really have: a project that is gone (soft-deleted) is dropped too, and nothing else is stored
        await _sql(f"UPDATE projects SET deleted_at = now() WHERE id = '{PROJ2}'")
        try:
            assert (await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ), (agent, PROJ2)), headers=tok)).json() == {"startable": 1}
            assert (await _sql(fetch=f"SELECT startable FROM desktop_setups WHERE id = '{sid}'"))[0][0] == [{"agent_member_id": agent, "project_id": str(PROJ)}]
        finally:
            await _sql(f"UPDATE projects SET deleted_at = NULL WHERE id = '{PROJ2}'")
        # a live project of ANOTHER organization is not stored either, even when a profile row links this agent to it
        other_org_project = uuid.UUID("d4424000-0000-0000-0000-0000000000a9")
        await _sql(
            f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES ('{other_org_project}','{ORG2}','Other org project','d4714-p9','warn') ON CONFLICT DO NOTHING",
            f"INSERT INTO agent_project_profiles (id,member_id,project_id) VALUES (gen_random_uuid(),'{agent}','{other_org_project}')",
        )
        try:
            assert (await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ), (agent, other_org_project)), headers=tok)).json() == {"startable": 1}
            assert (await _sql(fetch=f"SELECT startable FROM desktop_setups WHERE id = '{sid}'"))[0][0] == [{"agent_member_id": agent, "project_id": str(PROJ)}]
        finally:
            await _sql(f"DELETE FROM agent_project_profiles WHERE project_id = '{other_org_project}'", f"DELETE FROM projects WHERE id = '{other_org_project}'")
        # replaced whole, not merged
        assert (await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ2)), headers=tok)).json() == {"startable": 1}
        stored = (await _sql(fetch=f"SELECT startable FROM desktop_setups WHERE id = '{sid}'"))[0][0]
        assert stored == [{"agent_member_id": agent, "project_id": str(PROJ2)}]
        # an agent this device was not set up with · a path (or any extra field) · a pair without a project · too many
        assert (await c.put("/api/v2/desktop/relay/startable", json=_startable((str(uuid.uuid4()), PROJ)), headers=tok)).status_code == 422
        item = {"agent_member_id": agent, "project_id": str(PROJ)}
        assert (await c.put("/api/v2/desktop/relay/startable", json={"startable": [{**item, "path": "/Users/x/work"}]}, headers=tok)).status_code == 422
        assert (await c.put("/api/v2/desktop/relay/startable", json={"startable": [item], "folders": ["/x"]}, headers=tok)).status_code == 422
        assert (await c.put("/api/v2/desktop/relay/startable", json={"startable": [{"agent_member_id": agent}]}, headers=tok)).status_code == 422
        assert (await c.put("/api/v2/desktop/relay/startable", json={"startable": [item] * 129}, headers=tok)).status_code == 422
        assert (await _sql(fetch=f"SELECT startable FROM desktop_setups WHERE id = '{sid}'"))[0][0] == [{"agent_member_id": agent, "project_id": str(PROJ2)}]  # unchanged


async def test_02_the_phone_sees_only_its_paired_computers_and_only_projects_the_computer_has_a_folder_for_and_the_person_can_open(world):
    await _plain_member()  # the other person has a member row (their phone key needs one)
    async with _client() as c:
        device, agent, phone, der = await _setup(c, "d4424 mac 4714b")
        tok = _tok(device["device_token"])
        # silent computer (an app from before this): no projects, the phone says «start it at the Mac»
        view = (await _list(c, agent, phone)).json()
        assert [x["projects"] for x in view["computers"]] == [[]] and view["remote_control"] is True
        await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ), (agent, PROJ2)), headers=tok)
        view = (await _list(c, agent, phone)).json()
        comp = view["computers"][0]
        assert comp["setup_id"] == device["setup_id"] and comp["reachable"] is True and comp["can_command"] is True
        # PROJ2: the owner (an org owner) opens every project → both; ids and names, and not one key beyond these
        assert sorted(p["project_id"] for p in comp["projects"]) == sorted([str(PROJ), str(PROJ2)])
        assert all(set(p) == {"project_id", "name"} for p in comp["projects"])
        assert set(comp) == {"setup_id", "device_name", "reachable", "can_command", "projects"}
        # a project the agent is not in is never offered, even if the computer says it
        await _sql(f"UPDATE desktop_setups SET startable = '[{{\"agent_member_id\": \"{agent}\", \"project_id\": \"{PROJ3}\"}}]'::jsonb WHERE id = '{device['setup_id']}'")
        assert (await _list(c, agent, phone)).json()["computers"][0]["projects"] == []
        # another person's phone key → no computer of mine (paired_phone is the person's own)
        plain_phone, _plain_der = await _register(c, PLAIN)
        assert (await _list(c, agent, plain_phone)).json()["computers"] == []
        # an unreachable computer is listed as such (the phone says it is not heard from)
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '5 minutes' WHERE setup_id = '{device['setup_id']}'")
        assert (await _list(c, agent, phone)).json()["computers"][0]["reachable"] is False
        # a person without access to the agent: 404
        assert (await _list(c, agent, phone, who=PLAIN)).status_code == 404


async def test_03_a_start_is_a_command_with_exactly_the_agent_the_project_and_the_signature(world):
    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4424 mac 4714c")
        sid = device["setup_id"]
        await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ)), headers=_tok(device["device_token"]))
        key = str(uuid.uuid4())
        r = await _post(c, agent, _start(phone, sid, key=key))
        assert r.status_code == 201 and r.json()["state"] == "queued", r.text
        rows = await _commands(sid)
        assert len(rows) == 1 and rows[0][0] == "start_session"
        # nothing but agent · project · signed went down — no runtime, no path, no mode, no argument
        assert rows[0][1] == {"agent_member_id": agent, "project_id": str(PROJ), "signed": "eyJ2IjoxfQ.signed-by-the-phone"}
        # the same press again → the same command, no second row
        again = await _post(c, agent, _start(phone, sid, key=key))
        assert (again.status_code, again.json()["command_id"]) == (201, r.json()["command_id"])
        assert len(await _commands(sid)) == 1
        # no room for a folder · path · mode · arguments · runtime beside the request
        for extra in ({"path": "/tmp"}, {"cwd": "/tmp"}, {"mode": "bypass"}, {"args": ["--x"]}, {"runtime": "codex"}, {"folder": "/x"}):
            assert (await _post(c, agent, _start(phone, sid, **extra))).status_code == 422, extra
        assert len(await _commands(sid)) == 1


async def test_04_who_may_press_the_computer_the_pairing_and_the_project_are_each_checked(world):
    plain_tm = await _plain_member()
    await _sql(f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES (gen_random_uuid(),'{PROJ}','{plain_tm}','granted')")
    async with _client() as c:
        device, agent, phone, der = await _setup(c, "d4424 mac 4714d")
        sid = device["setup_id"]
        await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ)), headers=_tok(device["device_token"]))
        plain_phone, plain_der = await _register(c, PLAIN)
        await _pair(c, device["device_token"], der, plain_der)
        # a plain member (not owner/admin · not the agent's owner · not who confirmed the device) may not
        r = await _post(c, agent, _start(plain_phone, sid), who=PLAIN)
        assert (r.status_code, r.json()["error"]["code"]) == (403, "not_allowed_to_command")
        # the list says the same: this person may see the computer (their phone is paired · they can open the project) but may not command it
        seen = (await _list(c, agent, plain_phone, who=PLAIN)).json()["computers"]
        assert [x["can_command"] for x in seen] == [False]
        # someone else's phone key · a phone not paired with this computer
        borrowed = await _post(c, agent, _start(plain_phone, sid))
        assert (borrowed.status_code, borrowed.json()["error"]["code"]) == (409, "phone_not_paired")
        lone, _ = await _register(c, label="old phone")
        r = await _post(c, agent, _start(lone, sid))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "phone_not_paired")
        # a computer that is not this agent's (a made-up id · another agent's computer)
        r = await _post(c, agent, _start(phone, str(uuid.uuid4())))
        assert (r.status_code, r.json()["error"]["code"]) == (404, "computer_not_found")
        # a project the agent is not in
        r = await _post(c, agent, _start(phone, sid, project=PROJ3))
        assert (r.status_code, r.json()["error"]["code"]) == (404, "project_not_found")
        # a project the agent is in but this computer has no folder for → the same word the computer would answer
        r = await _post(c, agent, _start(phone, sid, project=PROJ2))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "no_folder")
        # off · unreachable
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = NULL WHERE id = '{ORG}'")
        r = await _post(c, agent, _start(phone, sid))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "remote_control_off")
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG}'",
                   f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '5 minutes' WHERE setup_id = '{sid}'")
        r = await _post(c, agent, _start(phone, sid))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "device_unreachable")
        assert await _commands(sid) == []  # none of these made a command


async def test_05_only_a_persons_own_session_presses_a_start_and_a_made_up_shape_has_no_way_in(world):
    from app.core.database import async_session_factory
    from app.repositories.human_api_key import HumanApiKeyRepository

    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4424 mac 4714e")
        sid = device["setup_id"]
        await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ)), headers=_tok(device["device_token"]))
        async with async_session_factory() as s:
            _k, plaintext = await HumanApiKeyRepository(s).create(member_id=OWNER_TM, name="d4714 script", expires_at=None)
            await s.commit()
        try:
            for headers in ({"Authorization": f"Bearer {plaintext}", "X-Org-Id": str(ORG)},
                            {"Authorization": f"Bearer {device['agents'][0]['api_key']}", "X-Org-Id": str(ORG)}):
                r = await _post(c, agent, _start(phone, sid), headers=headers)
                assert (r.status_code, r.json()["error"]["code"]) == (403, "person_session_required")
                # the two reads are the person's own too — the agent's list and the whole phone's list
                for url in (f"/api/v2/agents/{agent}/desktop-startable", "/api/v2/desktop/startable"):
                    g = await c.get(url, params={"phone_key_id": phone}, headers=headers)
                    assert (g.status_code, g.json()["error"]["code"]) == (403, "person_session_required"), url
        finally:
            await _sql(f"DELETE FROM human_api_keys WHERE member_id = '{OWNER_TM}'")
        # the queue itself takes no old shape: {agent, runtime} (no maker any more) and an unsigned one are refused
        from app.services.desktop_relay import DesktopRelayError, enqueue_command  # noqa: PLC0415
        from app.models.desktop_setup import DesktopSetup  # noqa: PLC0415

        async with async_session_factory() as s:
            setup = await s.get(DesktopSetup, uuid.UUID(sid))
            for payload in ({"agent_member_id": agent, "runtime": "claude"}, {"agent_member_id": agent, "project_id": str(PROJ)}):
                with pytest.raises(DesktopRelayError) as e:
                    await enqueue_command(s, setup=setup, kind="start_session", payload=payload, idempotency_key=str(uuid.uuid4()), requested_by=OWNER)
                assert e.value.status == 422, payload
        assert await _commands(sid) == []


async def test_06_a_person_sees_and_starts_only_projects_they_can_open(world):
    """The agent is in two projects; the computer has a folder for both; this person (the agent's owner, a plain org member) may open
    only one of them → the list shows that one and a start for the other is project_not_found (the server offers no project its asker
    cannot open)."""
    plain_tm = await _plain_member()
    await _sql(f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES (gen_random_uuid(),'{PROJ}','{plain_tm}','granted')")
    async with _client() as c:
        device, agent, owner_phone, owner_der = await _setup(c, "d4424 mac 4714f")
        sid = device["setup_id"]
        await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ), (agent, PROJ2)), headers=_tok(device["device_token"]))
        plain_phone, plain_der = await _register(c, PLAIN)
        await _pair(c, device["device_token"], owner_der, plain_der)
        await _sql(f"UPDATE members SET owner_member_id = '{plain_tm}' WHERE id = '{agent}'")  # may command, as the agent's owner
        # a borrowed key lists nothing even when that key IS paired with this computer (the key must be the asker's own) — both ways
        assert (await _list(c, agent, plain_phone, who=OWNER)).json()["computers"] == []
        assert (await _list(c, agent, owner_phone, who=PLAIN)).json()["computers"] == []
        comp = (await _list(c, agent, plain_phone, who=PLAIN)).json()["computers"][0]
        assert comp["can_command"] is True and [p["project_id"] for p in comp["projects"]] == [str(PROJ)]
        r = await _post(c, agent, _start(plain_phone, sid, project=PROJ2), who=PLAIN)
        assert (r.status_code, r.json()["error"]["code"]) == (404, "project_not_found")
        assert (await _post(c, agent, _start(plain_phone, sid, project=PROJ), who=PLAIN)).status_code == 201
        assert len(await _commands(sid)) == 1
        # the project is soft-deleted after the computer reported it: neither read names it any more (the agent's view of the person goes with it — can_view — and the
        # project query filters `deleted_at` too; a mutant that drops only the latter is not observable through this route, the two guard the same thing)
        await _sql(f"UPDATE projects SET deleted_at = now() WHERE id = '{PROJ}'")
        try:
            assert str(PROJ) not in (await _list(c, agent, plain_phone, who=PLAIN)).text
            assert str(PROJ) not in (await _all(c, plain_phone, who=PLAIN)).text
        finally:
            await _sql(f"UPDATE projects SET deleted_at = NULL WHERE id = '{PROJ}'")


async def test_07_a_key_is_one_persons_own_and_a_deactivated_agent_starts_nothing_and_is_offered_nothing(world):
    """Two people who may both press with the SAME idempotency key get their own commands (the key is namespaced by the person); a
    deactivated agent with a live computer, pairing and folder pair is neither offered nor started."""
    plain_tm = await _plain_member()
    await _sql(f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES (gen_random_uuid(),'{PROJ}','{plain_tm}','granted')",
               f"UPDATE org_members SET role = 'admin' WHERE org_id = '{ORG}' AND user_id = '{PLAIN}'")
    async with _client() as c:
        device, agent, owner_phone, owner_der = await _setup(c, "d4424 mac 4714g")
        sid = device["setup_id"]
        await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ)), headers=_tok(device["device_token"]))
        plain_phone, plain_der = await _register(c, PLAIN)
        await _pair(c, device["device_token"], owner_der, plain_der)
        key = str(uuid.uuid4())
        mine = await _post(c, agent, _start(owner_phone, sid, key=key))
        theirs = await _post(c, agent, _start(plain_phone, sid, key=key), who=PLAIN)  # an org admin: may press, with their own phone
        assert (mine.status_code, theirs.status_code) == (201, 201), (mine.text, theirs.text)
        assert mine.json()["command_id"] != theirs.json()["command_id"]
        assert len(await _commands(sid)) == 2
        # deactivated agent: not offered, not started
        await _sql(f"UPDATE members SET is_active = false WHERE id = '{agent}'")
        assert (await _list(c, agent, owner_phone)).json()["computers"] == []
        r = await _post(c, agent, _start(owner_phone, sid))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "agent_inactive")
        assert len(await _commands(sid)) == 2


async def test_08_two_presses_of_one_key_at_once_make_one_command_not_a_500(world):
    import asyncio

    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4424 mac 4714h")
        sid = device["setup_id"]
        await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ)), headers=_tok(device["device_token"]))
        key = str(uuid.uuid4())
        answers = await asyncio.gather(*[_post(c, agent, _start(phone, sid, key=key)) for _ in range(4)])
        assert [a.status_code for a in answers] == [201, 201, 201, 201], [a.text for a in answers]
        assert len({a.json()["command_id"] for a in answers}) == 1
        assert len(await _commands(sid)) == 1


def _all(c, phone, who=OWNER, headers=None):
    return c.get("/api/v2/desktop/startable", params={"phone_key_id": phone}, headers=headers or _person(who))


async def test_09_the_first_screen_in_one_read_every_paired_computer_with_its_agents_and_startable_projects(world):
    """contract v1.18: the phone's paired computers → each one's agents (active · the person can open) → the projects each can be started for.
    A paired computer with no agent lists `agents: []`; only this asker's own paired key lists anything; ids and names, never a path."""
    from app.core.database import async_session_factory
    from app.repositories.human_api_key import HumanApiKeyRepository

    plain_tm = await _plain_member()
    await _sql(f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES (gen_random_uuid(),'{PROJ}','{plain_tm}','granted')")
    async with _client() as c:
        device, agent, phone, owner_der = await _setup(c, "d4424 mac 4714i")
        other_agent = device["agents"][1]["member_id"]
        sid = device["setup_id"]
        await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ), (agent, PROJ2)), headers=_tok(device["device_token"]))
        view = (await _all(c, phone)).json()
        assert set(view) == {"remote_control", "computers"} and view["remote_control"] is True
        comp = view["computers"][0]
        assert set(comp) == {"setup_id", "device_name", "reachable", "agents"} and comp["setup_id"] == sid and comp["reachable"] is True
        by_id = {a["agent_member_id"]: a for a in comp["agents"]}
        assert set(by_id) == {agent, other_agent}  # every agent this computer was set up with (the owner opens them all)
        assert all(set(a) == {"agent_member_id", "name", "can_command", "projects"} for a in comp["agents"])
        assert sorted(p["project_id"] for p in by_id[agent]["projects"]) == sorted([str(PROJ), str(PROJ2)]) and by_id[other_agent]["projects"] == []
        assert all(set(p) == {"project_id", "name"} for a in comp["agents"] for p in a["projects"])
        # a key that is not the asker's (even one paired with this computer) · a key paired with nothing lists no computer
        plain_phone, plain_der = await _register(c, PLAIN)
        await _pair(c, device["device_token"], owner_der, plain_der)
        assert (await _all(c, plain_phone, who=OWNER)).json()["computers"] == []
        assert (await _all(c, phone, who=PLAIN)).json()["computers"] == []
        lone, _ = await _register(c, label="old phone")
        assert (await _all(c, lone)).json()["computers"] == []
        # the plain member (project access to PROJ only, no right to command): sees the computer and only agents/projects they can open
        mine = (await _all(c, plain_phone, who=PLAIN)).json()["computers"][0]
        assert {a["agent_member_id"] for a in mine["agents"]} <= {agent, other_agent} and all(a["can_command"] is False for a in mine["agents"])
        assert all(p["project_id"] == str(PROJ) for a in mine["agents"] for p in a["projects"])
        # a person who may open none of these agents (their project access is gone) sees the paired computer and no agent on it
        await _sql(f"DELETE FROM project_access WHERE member_id = '{plain_tm}'")
        assert [x["agents"] for x in (await _all(c, plain_phone, who=PLAIN)).json()["computers"]] == [[]]
        # an agent set up here but deactivated is not listed; a computer left with no agent says `agents: []`
        await _sql(f"UPDATE members SET is_active = false WHERE id IN ('{agent}','{other_agent}')")
        assert (await _all(c, phone)).json()["computers"][0]["agents"] == []
        # a person's own session only
        async with async_session_factory() as s:
            _k, plaintext = await HumanApiKeyRepository(s).create(member_id=OWNER_TM, name="d4714 all", expires_at=None)
            await s.commit()
        try:
            r = await _all(c, phone, headers={"Authorization": f"Bearer {plaintext}", "X-Org-Id": str(ORG)})
            assert (r.status_code) == 403
        finally:
            await _sql(f"DELETE FROM human_api_keys WHERE member_id = '{OWNER_TM}'")


async def test_10_a_gone_pairing_a_disconnected_computer_and_a_deleted_project_leave_both_reads_and_a_list_that_changes_while_a_press_waits_is_the_new_one(world, monkeypatch):
    """codex 5132 round 4 ⑥: each filter of the two reads is pinned by what it removes — an unpaired phone (removed_at), a disconnected computer (revoked_at),
    a soft-deleted project; and ⑤ (nearest part): the press reads the computer's row again under its lock, so a folder list the computer replaced
    after the press began is the one the press is judged by (no_folder), not the copy read before waiting."""
    from app.services import desktop_commands

    async with _client() as c:
        device, agent, phone, _der = await _setup(c, "d4424 mac 4714j")
        sid = device["setup_id"]
        await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ), (agent, PROJ2)), headers=_tok(device["device_token"]))
        await _sql(f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES (gen_random_uuid(),'{PROJ2}','{OWNER_TM}','granted') ON CONFLICT DO NOTHING")

        async def shown():
            one = (await _list(c, agent, phone)).json()["computers"]
            every = (await _all(c, phone)).json()["computers"]
            return ([[p["project_id"] for p in x["projects"]] for x in one], [[[p["project_id"] for p in a["projects"]] for a in x["agents"] if a["agent_member_id"] == agent] for x in every])

        base_one, base_all = await shown()
        assert base_one and base_one[0] and base_all and base_all[0][0]  # the owner sees the computer and the agent's projects
        # the phone is unpaired (a removed pairing) → no computer in either read
        await _sql(f"UPDATE remote_device_pairings SET removed_at = now() WHERE setup_id = '{sid}'")
        assert (await shown()) == ([], [])
        await _sql(f"UPDATE remote_device_pairings SET removed_at = NULL WHERE setup_id = '{sid}'")
        assert (await shown()) == (base_one, base_all)
        # the computer is disconnected → no computer in either read, and a press is refused as an unknown computer
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{sid}'")
        assert (await shown()) == ([], [])
        assert (await _post(c, agent, _start(phone, sid))).status_code == 404
        await _sql(f"UPDATE desktop_setups SET revoked_at = NULL WHERE id = '{sid}'")
        # the computer replaces its folder list (empties it) right after the press read the computer and before it got the lock → the press sees the new list
        real = desktop_commands._agent_projects

        seen = {"n": 0}

        async def then_the_computer_replaces_its_list(db, agent_id):
            got = await real(db, agent_id)
            seen["n"] += 1
            if seen["n"] == 1:  # only after the FIRST judgement (the second runs under the row lock the update would wait for)
                await _sql(f"UPDATE desktop_setups SET startable = '[]'::jsonb WHERE id = '{sid}'")
            return got

        monkeypatch.setattr(desktop_commands, "_agent_projects", then_the_computer_replaces_its_list)
        r = await _post(c, agent, _start(phone, sid))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "no_folder")
        assert await _commands(sid) == []


async def test_11_what_is_taken_back_while_a_press_waits_for_the_computers_lock_is_seen_by_the_press(world, monkeypatch):
    """codex 5132 rounds 5 · 6: the press judges who may press (the agent active · the computer · the right to command, with the person's role read in
    the judgement · the project and its access) twice — once for the answer and again under the computer's row lock. Each case changes the truth right
    AFTER the first judgement has passed its last check (the project-access check), as a commit that lands while the press waits would: a project
    grant taken back · the agent deactivated · the phone unpaired · an org admin demoted."""
    from app.services import project_auth

    plain_tm = await _plain_member()
    real = project_auth.has_project_access

    async def run_case(change_sql, expect, case, as_admin=False):
        async with _client() as c:
            device, agent, owner_phone, owner_der = await _setup(c, f"d4424 mac 4714k{case}")
            sid = device["setup_id"]
            await _sql(f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES (gen_random_uuid(),'{PROJ}','{plain_tm}','granted') ON CONFLICT DO NOTHING")
            await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ)), headers=_tok(device["device_token"]))
            plain_phone, plain_der = await _register(c, PLAIN)
            await _pair(c, device["device_token"], owner_der, plain_der)
            if as_admin:  # commands as an org admin, not as the agent's owner
                await _sql(f"UPDATE org_members SET role = 'admin' WHERE org_id = '{ORG}' AND user_id = '{PLAIN}'")
            else:
                await _sql(f"UPDATE members SET owner_member_id = '{plain_tm}' WHERE id = '{agent}'")  # may command, as the agent's owner
            ok = await _post(c, agent, _start(plain_phone, sid), who=PLAIN)
            assert ok.status_code == 201, ok.text  # the same press with nothing changed is accepted
            n = len(await _commands(sid))
            calls = {"n": 0}

            async def then_the_truth_changes(session, user_id, project_id, org_id=None):
                got = await real(session, user_id, project_id, org_id)
                calls["n"] += 1
                if calls["n"] == 1:  # the first judgement's last check has just passed
                    await _sql(change_sql(agent, sid, plain_tm))
                return got

            monkeypatch.setattr(project_auth, "has_project_access", then_the_truth_changes)
            r = await _post(c, agent, _start(plain_phone, sid), who=PLAIN)
            monkeypatch.setattr(project_auth, "has_project_access", real)
            assert (r.status_code, r.json()["error"]["code"]) == expect, (case, r.text)
            assert len(await _commands(sid)) == n  # nothing queued after the truth changed
            await _sql(f"UPDATE members SET is_active = true WHERE id = '{agent}'",
                       f"UPDATE org_members SET role = 'member' WHERE org_id = '{ORG}' AND user_id = '{PLAIN}'",
                       f"UPDATE remote_devices SET revoked_at = now() WHERE member_id IN ('{plain_tm}','{OWNER_TM}') AND revoked_at IS NULL")  # two phones per case (at most three per person)

    await run_case(lambda agent, sid, tm: f"DELETE FROM project_access WHERE member_id = '{tm}' AND project_id = '{PROJ}'", (404, "project_not_found"), "a")
    await run_case(lambda agent, sid, tm: f"UPDATE members SET is_active = false WHERE id = '{agent}'", (409, "agent_inactive"), "b")
    await run_case(lambda agent, sid, tm: f"UPDATE remote_device_pairings SET removed_at = now() WHERE setup_id = '{sid}'", (409, "phone_not_paired"), "c")
    await run_case(lambda agent, sid, tm: f"UPDATE org_members SET role = 'member' WHERE org_id = '{ORG}' AND user_id = '{PLAIN}'", (403, "not_allowed_to_command"), "d", as_admin=True)
    await run_case(lambda agent, sid, tm: f"DELETE FROM agent_project_profiles WHERE member_id = '{agent}' AND project_id = '{PROJ}'", (404, "project_not_found"), "e")  # the agent leaves the project; the person still has access


async def test_12_one_computers_list_replaces_only_its_own(world):
    """codex 5132 round 7 ⑥: a computer's PUT writes ITS row only — a second computer's list stays as that computer said it."""
    async with _client() as c:
        dev1, agent1, _p1, _d1 = await _setup(c, "d4424 mac 4714m1")
        dev2, agent2, _p2, _d2 = await _setup(c, "d4424 mac 4714m2")
        assert dev1["setup_id"] != dev2["setup_id"]
        assert (await c.put("/api/v2/desktop/relay/startable", json=_startable((agent2, PROJ2)), headers=_tok(dev2["device_token"]))).status_code == 200
        assert (await c.put("/api/v2/desktop/relay/startable", json=_startable((agent1, PROJ)), headers=_tok(dev1["device_token"]))).status_code == 200
        one = (await _sql(fetch=f"SELECT startable FROM desktop_setups WHERE id = '{dev1['setup_id']}'"))[0][0]
        two = (await _sql(fetch=f"SELECT startable FROM desktop_setups WHERE id = '{dev2['setup_id']}'"))[0][0]
        assert one == [{"agent_member_id": agent1, "project_id": str(PROJ)}]
        assert two == [{"agent_member_id": agent2, "project_id": str(PROJ2)}]


async def test_13_one_key_on_two_computers_is_two_commands(world):
    """codex 5132 round 8 ⑥: a same-key press is the same press only on the same computer — the same person with the same key on another computer
    queues its own command (the same-key lookup is scoped to the computer)."""
    async with _client() as c:
        dev1, agent1, phone1, _d1 = await _setup(c, "d4424 mac 4714n1")
        dev2, agent2, phone2, _d2 = await _setup(c, "d4424 mac 4714n2")
        for dev, agent in ((dev1, agent1), (dev2, agent2)):
            assert (await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ)), headers=_tok(dev["device_token"]))).status_code == 200
        key = str(uuid.uuid4())
        r1 = await _post(c, agent1, _start(phone1, dev1["setup_id"], key=key))
        r2 = await _post(c, agent2, _start(phone2, dev2["setup_id"], key=key))
        assert (r1.status_code, r2.status_code) == (201, 201), (r1.text, r2.text)
        assert r1.json()["command_id"] != r2.json()["command_id"]
        assert len(await _commands(dev1["setup_id"])) == 1 and len(await _commands(dev2["setup_id"])) == 1


async def test_14_the_whole_phone_read_lists_only_the_computer_this_phone_is_paired_with(world):
    """codex 5132 round 9 ⑥: two computers in the organization, each paired with its own phone — a phone sees ITS computer and not the other one."""
    async with _client() as c:
        dev1, agent1, phone1, _d1 = await _setup(c, "d4424 mac 4714p1")
        dev2, agent2, phone2, _d2 = await _setup(c, "d4424 mac 4714p2")
        for dev, agent in ((dev1, agent1), (dev2, agent2)):
            assert (await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ)), headers=_tok(dev["device_token"]))).status_code == 200
        assert dev1["setup_id"] != dev2["setup_id"]
        seen1 = [x["setup_id"] for x in (await _all(c, phone1)).json()["computers"]]
        seen2 = [x["setup_id"] for x in (await _all(c, phone2)).json()["computers"]]
        assert seen1 == [dev1["setup_id"]] and seen2 == [dev2["setup_id"]]


async def test_15_a_phone_starts_only_on_the_computer_it_is_paired_with_and_only_while_the_pairing_and_the_key_live(world):
    """codex 5132 round 10 ⑥: `paired_phone` is the single «this phone is paired with THIS computer now» check — each of its parts pinned here."""
    async with _client() as c:
        dev1, agent1, phone1, _d1 = await _setup(c, "d4424 mac 4714q1")
        dev2, agent2, phone2, _d2 = await _setup(c, "d4424 mac 4714q2")
        for dev, agent in ((dev1, agent1), (dev2, agent2)):
            assert (await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ)), headers=_tok(dev["device_token"]))).status_code == 200
        sid2 = dev2["setup_id"]
        # phone1 is paired with computer 1 only: on computer 2 it is not a paired phone (refused · and the agent's list shows it nothing)
        r = await _post(c, agent2, _start(phone1, sid2))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "phone_not_paired")
        assert (await _list(c, agent2, phone1)).json()["computers"] == []
        assert await _commands(sid2) == []
        # its own computer: accepted
        assert (await _post(c, agent2, _start(phone2, sid2))).status_code == 201
        # the pairing is taken away → refused (a removed pairing is not a pairing)
        await _sql(f"UPDATE remote_device_pairings SET removed_at = now() WHERE setup_id = '{sid2}'")
        r = await _post(c, agent2, _start(phone2, sid2))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "phone_not_paired")
        await _sql(f"UPDATE remote_device_pairings SET removed_at = NULL WHERE setup_id = '{sid2}'")
        assert (await _post(c, agent2, _start(phone2, sid2))).status_code == 201
        # the key is revoked → refused (a revoked key is not a phone)
        await _sql(f"UPDATE remote_devices SET revoked_at = now() WHERE id = '{phone2}'")
        r = await _post(c, agent2, _start(phone2, sid2))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "phone_not_paired")


async def test_16_the_whole_phone_read_drops_a_revoked_key_and_an_agent_the_person_cannot_open(world):
    """codex 5132 round 11 ⑥ (the full list of unpinned predicates): (a) a revoked phone key lists nothing in the whole-phone read; (b) `can_view` looks at the
    TARGET agent's own projects only — a person who may open agent B's project but none of agent A's does not see agent A's computer through B."""
    plain_tm = await _plain_member()
    async with _client() as c:
        device, agent, phone, owner_der = await _setup(c, "d4424 mac 4714r")
        other = device["agents"][1]["member_id"]
        sid = device["setup_id"]
        await _sql(
            f"DELETE FROM agent_project_profiles WHERE member_id = '{other}'",
            f"INSERT INTO agent_project_profiles (id,member_id,project_id) VALUES (gen_random_uuid(),'{other}','{PROJ2}')",  # the other agent: a project the plain person cannot open
            f"INSERT INTO agent_project_profiles (id,member_id,project_id) SELECT gen_random_uuid(),'{agent}','{PROJ}' WHERE NOT EXISTS "
            f"(SELECT 1 FROM agent_project_profiles WHERE member_id = '{agent}' AND project_id = '{PROJ}')",
            f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES (gen_random_uuid(),'{PROJ}','{plain_tm}','granted') ON CONFLICT DO NOTHING",
        )
        await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ), (other, PROJ2)), headers=_tok(device["device_token"]))
        plain_phone, plain_der = await _register(c, PLAIN)
        await _pair(c, device["device_token"], owner_der, plain_der)
        # (b) the plain person opens agent `agent` (PROJ) and not agent `other` (PROJ2 only): the whole-phone read names the one, the other's own read is a 404
        comp = (await _all(c, plain_phone, who=PLAIN)).json()["computers"][0]
        assert [a["agent_member_id"] for a in comp["agents"]] == [agent]
        gone = await _list(c, other, plain_phone, who=PLAIN)
        assert (gone.status_code, gone.json()["error"]["code"]) == (404, "agent_not_found")
        # (a) the key is revoked → the whole-phone read lists nothing
        assert [x["setup_id"] for x in (await _all(c, phone)).json()["computers"]] == [sid]
        await _sql(f"UPDATE remote_devices SET revoked_at = now() WHERE id = '{phone}'")
        assert (await _all(c, phone)).json()["computers"] == []
