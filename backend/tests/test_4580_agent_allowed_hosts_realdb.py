"""story #4580 (E-DESKTOP-2 · AC2 A) — a desktop agent's «허용 주소» list on the server.

Read by a person with the run profile (web «실행» group · Yuna ④) and by the daemon with the agent's own key (it writes the folder's
`WebFetch(domain:<host>)` lines from it); [빼기] by whoever may change the run profile (4540 §3 ⓔ) from a person's own session —
idempotent, the version moving only when a row went (the daemon's «running ≠ saved» check). Adding is story #4580 B (after a
person's signed answer) — seeded here by SQL.
"""
from __future__ import annotations

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    OUTSIDER,
    OWNER,
    OWNER_TM,
    PLAIN,
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


def _one(agent) -> str:
    return f"/api/v2/agents/{agent}/run-profile"


def _rm(agent, host) -> str:
    return f"/api/v2/agents/{agent}/run-profile/allowed-hosts/{host}"


def _key(device, i=0) -> dict:
    return {"Authorization": f"Bearer {device['agents'][i]['api_key']}", "X-Org-Id": str(ORG)}


def _code(r) -> tuple[int, str | None]:
    body = r.json()
    return r.status_code, (body.get("error") or {}).get("code") if isinstance(body, dict) else None


async def _seed(agent, *hosts) -> None:
    for h in hosts:
        await _sql(f"INSERT INTO agent_allowed_hosts (member_id, host) VALUES ('{agent}', '{h}')")


async def _version(agent) -> int | None:
    rows = await _sql(fetch=f"SELECT version FROM agent_run_profiles WHERE member_id = '{agent}'")
    return rows[0][0] if rows else None


async def _set_runtime(agent, runtime: str) -> None:
    await _sql(f"UPDATE members SET runtime_type = '{runtime}' WHERE id = '{agent}'")


async def test_01_a_person_and_the_daemon_read_the_list_each_their_own(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4580a")
        agent, other = device["agents"][0]["member_id"], device["agents"][1]["member_id"]
        await _set_runtime(agent, "claude-code")
        await _set_runtime(other, "claude-code")
        await _seed(agent, "pypi.org", "gitlab.com")

        seen = await c.get(_one(agent), headers=_person(OWNER))
        assert seen.status_code == 200, seen.text
        assert [h["host"] for h in seen.json()["allowed_hosts"]] == ["gitlab.com", "pypi.org"]  # sorted
        assert all(h["added_at"] for h in seen.json()["allowed_hosts"])
        assert set(seen.json()["allowed_hosts"][0]) == {"host", "added_at"}  # who added it stays on the server

        own = await c.get(OWN, headers=_key(device))
        assert own.status_code == 200, own.text
        assert own.json()["allowed_hosts"] == ["gitlab.com", "pypi.org"]
        theirs = await c.get(OWN, headers=_key(device, 1))
        assert theirs.json()["allowed_hosts"] == []  # another agent's list is never read with this key
        assert (await c.get(_one(other), headers=_person(OWNER))).json()["allowed_hosts"] == []


async def test_02_remove_is_immediate_idempotent_and_moves_the_version_only_when_a_row_went(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4580b")
        agent = device["agents"][0]["member_id"]
        await _set_runtime(agent, "claude-code")
        await _seed(agent, "pypi.org", "gitlab.com")
        assert await _version(agent) is None  # no run profile row yet

        r = await c.delete(_rm(agent, "GitLab.com"), headers=_person(OWNER))  # case-folded to the stored form
        assert r.status_code == 200, r.text
        assert r.json() == {"host": "gitlab.com", "removed": True}
        assert await _version(agent) == 1  # made with the defaults kept · the daemon sees a change
        assert (await c.get(OWN, headers=_key(device))).json()["allowed_hosts"] == ["pypi.org"]
        assert (await c.get(OWN, headers=_key(device))).json()["version"] == 1

        again = await c.delete(_rm(agent, "gitlab.com"), headers=_person(OWNER))
        assert again.status_code == 200 and again.json() == {"host": "gitlab.com", "removed": False}
        assert await _version(agent) == 1  # nothing went: no new version

        await c.put(_one(agent), json={"model": "opus", "effort": "high"}, headers=_person(OWNER))
        assert await _version(agent) == 2
        r = await c.delete(_rm(agent, "pypi.org"), headers=_person(OWNER))
        assert r.json()["removed"] is True
        assert await _version(agent) == 3
        view = (await c.get(_one(agent), headers=_person(OWNER))).json()
        assert (view["model"], view["effort"], view["allowed_hosts"]) == ("opus", "high", [])  # model · effort kept

        for bad in ("*.example.com", "example.com:443", "-bad.com", "a" * 254, "exa mple.com"):
            assert _code(await c.delete(_rm(agent, bad), headers=_person(OWNER))) == (422, "invalid_host"), bad


async def test_03_who_may_remove(world):
    from app.core.database import async_session_factory
    from app.repositories.human_api_key import HumanApiKeyRepository

    async with _client() as c:
        device = await _device(c, name="d4424 mac 4580c")
        agent = device["agents"][0]["member_id"]
        await _set_runtime(agent, "claude-code")
        await _seed(agent, "pypi.org")
        plain_tm = (await _sql(fetch=f"SELECT id FROM org_members WHERE org_id = '{ORG}' AND user_id = '{PLAIN}'"))[0][0]
        await _sql(f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES ('{plain_tm}','{ORG}','{PLAIN}','human','Plain',true)")

        assert (await c.get(_one(agent), headers=_person(PLAIN))).json()["allowed_hosts"][0]["host"] == "pypi.org"  # may read
        assert (await c.delete(_rm(agent, "pypi.org"), headers=_person(PLAIN))).status_code == 403  # may not remove

        async with async_session_factory() as s:
            _k, plaintext = await HumanApiKeyRepository(s).create(member_id=OWNER_TM, name="d4580 script", expires_at=None)
            await s.commit()
        try:
            for headers in ({"Authorization": f"Bearer {plaintext}", "X-Org-Id": str(ORG)}, _key(device)):
                assert _code(await c.delete(_rm(agent, "pypi.org"), headers=headers)) == (403, "person_session_required")
        finally:
            await _sql(f"DELETE FROM human_api_keys WHERE member_id = '{OWNER_TM}'")
        assert (await c.delete(_rm(agent, "pypi.org"), headers=_person(OUTSIDER))).status_code in (403, 404)

        await _set_runtime(agent, "system-publisher")
        assert _code(await c.delete(_rm(agent, "pypi.org"), headers=_person(OWNER))) == (409, "SYSTEM_PUBLISHER_RESERVED")
        assert (await _sql(fetch=f"SELECT count(*) FROM agent_allowed_hosts WHERE member_id = '{agent}'"))[0][0] == 1


# ── story #4580 AC2 B (Kadir ⓐ) — the second answer and the host it adds ──────────────────────────────────────────────────

from datetime import datetime, timedelta, timezone  # noqa: E402

from tests.test_4529_desktop_relay_realdb import _tok  # noqa: E402
from tests.test_4533_agent_permissions_realdb import (  # noqa: E402,F401 — the 4533 helpers (its autouse fixture too)
    REQS,
    _answer,
    _ask,
    _pair,
    _post_ask,
    _register,
    _remote_control_on,
    _with_session,
)


def _later(minutes=10) -> str:
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()


def _confirm(rid) -> str:
    return f"/api/v2/desktop/relay/permission-requests/{rid}/confirm-host"


def _added(rid) -> str:
    return f"/api/v2/desktop/relay/permission-requests/{rid}/host-added"


async def _network_ask(c, device, agent):
    body = _ask(agent, tool="SandboxNetwork", summary="network", input_hash="sha256:" + "b" * 64)
    made = await _post_ask(c, device, body)
    assert made.status_code == 201, made.text
    return body["request_id"], made.json()["id"]


async def test_05_allow_then_the_host_then_a_second_signed_allow_adds_exactly_that_host(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4580d")
        token, sid = device["device_token"], device["setup_id"]
        agent = await _with_session(c, device)
        await _set_runtime(agent, "claude-code")
        phone, der = await _register(c)
        await _pair(c, token, der)
        rid, pk = await _network_ask(c, device, agent)

        # the host-added report before any confirmed answer: refused
        r = await c.post(_added(rid), json={"host": "gitlab.com"}, headers=_tok(token))
        assert _code(r) == (409, "not_confirmed")
        # ① the first answer «allow…» (no host yet)
        ok = await c.post(f"{REQS}/{pk}/answer", json=_answer(phone), headers=_person(OWNER))
        assert ok.status_code == 200, ok.text
        # ② the daemon: Esc · the host from Claude's own hook text → the same row, stage confirm, waiting again
        r = await c.post(_confirm(rid), json={"host": "GitLab.com", "expires_at": _later()}, headers=_tok(token))
        assert r.status_code == 200 and r.json() == {"id": pk, "state": "pending", "stage": "confirm"}, r.text
        [view] = (await c.get(REQS, headers=_person(OWNER))).json()["requests"]
        assert (view["stage"], view["host"], view["state"], view["decision"], view["answerable"]) == ("confirm", "gitlab.com", "pending", None, True)
        assert view["input_hash"] == "sha256:" + "b" * 64  # what the phone signs, with the host
        again = await c.post(_confirm(rid), json={"host": "gitlab.com", "expires_at": _later()}, headers=_tok(token))
        assert again.status_code == 200  # the same report: the same row
        other = await c.post(_confirm(rid), json={"host": "evil.example", "expires_at": _later()}, headers=_tok(token))
        assert _code(other) == (409, "host_mismatch")  # never replaced
        # ③ the second answer: its own command (the first one's key would drop it) carrying the host the person saw
        ok2 = await c.post(f"{REQS}/{pk}/answer", json=_answer(phone, signed="eyJ2IjoxfQ.second"), headers=_person(OWNER))
        assert ok2.status_code == 200, ok2.text
        cmds = await _sql(fetch=f"SELECT idempotency_key, payload FROM desktop_commands WHERE setup_id = '{sid}' ORDER BY created_at")
        assert [k for k, _p in cmds] == [f"perm:{rid}", f"perm:{rid}:confirm"]
        assert "host" not in cmds[0][1] and cmds[1][1]["host"] == "gitlab.com" and cmds[1][1]["stage"] == "confirm"
        assert cmds[1][1]["signed"] == "eyJ2IjoxfQ.second"
        # ④ the daemon checked the signature and wrote the line: only the row's own host joins the list
        assert _code(await c.post(_added(rid), json={"host": "evil.example"}, headers=_tok(token))) == (409, "host_mismatch")
        r = await c.post(_added(rid), json={"host": "gitlab.com"}, headers=_tok(token))
        assert r.status_code == 200 and r.json() == {"added": True}, r.text
        row = await _sql(fetch=f"SELECT host, added_by, request_id FROM agent_allowed_hosts WHERE member_id = '{agent}'")
        assert [(h, str(b), str(q)) for h, b, q in row] == [("gitlab.com", str(OWNER_TM), rid)]
        assert await _version(agent) == 1  # the daemon's «running ≠ saved» sees it
        assert (await c.post(_added(rid), json={"host": "gitlab.com"}, headers=_tok(token))).json() == {"added": False}
        assert (await c.get(OWN, headers=_key(device))).json()["allowed_hosts"] == ["gitlab.com"]


async def test_06_what_never_gets_a_second_answer_or_adds_a_host(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4580e")
        token = device["device_token"]
        agent = await _with_session(c, device)
        phone, der = await _register(c)
        await _pair(c, token, der)

        # a tool's request (not the network question) has no second answer
        tool = _ask(agent)
        made = await _post_ask(c, device, tool)
        await c.post(f"{REQS}/{made.json()['id']}/answer", json=_answer(phone), headers=_person(OWNER))
        r = await c.post(_confirm(tool["request_id"]), json={"host": "gitlab.com", "expires_at": _later()}, headers=_tok(token))
        assert _code(r) == (409, "not_a_network_request")

        # not answered yet · answered «deny»: no second answer
        rid, pk = await _network_ask(c, device, agent)
        assert _code(await c.post(_confirm(rid), json={"host": "gitlab.com", "expires_at": _later()}, headers=_tok(token))) == (409, "not_allowed_yet")
        await c.post(f"{REQS}/{pk}/answer", json=_answer(phone, "deny"), headers=_person(OWNER))
        assert _code(await c.post(_confirm(rid), json={"host": "gitlab.com", "expires_at": _later()}, headers=_tok(token))) == (409, "not_allowed_yet")

        # an IP in any spelling, a wildcard, a port: refused by the one host rule
        rid2, pk2 = await _network_ask(c, device, agent)
        await c.post(f"{REQS}/{pk2}/answer", json=_answer(phone), headers=_person(OWNER))
        for bad in ("1.2.3.4", "0x7f000001", "*.example.com", "example.com:443"):
            r = await c.post(_confirm(rid2), json={"host": bad, "expires_at": _later()}, headers=_tok(token))
            assert _code(r) == (422, "invalid_host"), bad
        # another device's token never reaches this device's row
        other = await _device(c, name="d4424 mac 4580f")
        r = await c.post(_confirm(rid2), json={"host": "gitlab.com", "expires_at": _later()}, headers=_tok(other["device_token"]))
        assert _code(r) == (404, "request_not_found")
        # the second answer «deny»: nothing added
        await c.post(_confirm(rid2), json={"host": "gitlab.com", "expires_at": _later()}, headers=_tok(token))
        await c.post(f"{REQS}/{pk2}/answer", json=_answer(phone, "deny"), headers=_person(OWNER))
        assert _code(await c.post(_added(rid2), json={"host": "gitlab.com"}, headers=_tok(token))) == (409, "not_confirmed")
        assert (await _sql(fetch=f"SELECT count(*) FROM agent_allowed_hosts WHERE member_id = '{agent}'"))[0][0] == 0
