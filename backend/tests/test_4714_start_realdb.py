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
        ok = await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ), (agent, PROJ2), (agent, PROJ)), headers=tok)
        assert (ok.status_code, ok.json()) == (200, {"startable": 2})  # sorted · no repeat
        stored = (await _sql(fetch=f"SELECT startable FROM desktop_setups WHERE id = '{sid}'"))[0][0]
        assert sorted(stored, key=lambda i: i["project_id"]) == [{"agent_member_id": agent, "project_id": str(PROJ)}, {"agent_member_id": agent, "project_id": str(PROJ2)}]
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
        device, agent, _owner_phone, owner_der = await _setup(c, "d4424 mac 4714f")
        sid = device["setup_id"]
        await c.put("/api/v2/desktop/relay/startable", json=_startable((agent, PROJ), (agent, PROJ2)), headers=_tok(device["device_token"]))
        plain_phone, plain_der = await _register(c, PLAIN)
        await _pair(c, device["device_token"], owner_der, plain_der)
        await _sql(f"UPDATE members SET owner_member_id = '{plain_tm}' WHERE id = '{agent}'")  # may command, as the agent's owner
        comp = (await _list(c, agent, plain_phone, who=PLAIN)).json()["computers"][0]
        assert comp["can_command"] is True and [p["project_id"] for p in comp["projects"]] == [str(PROJ)]
        r = await _post(c, agent, _start(plain_phone, sid, project=PROJ2), who=PLAIN)
        assert (r.status_code, r.json()["error"]["code"]) == (404, "project_not_found")
        assert (await _post(c, agent, _start(plain_phone, sid, project=PROJ), who=PLAIN)).status_code == 201
        assert len(await _commands(sid)) == 1
