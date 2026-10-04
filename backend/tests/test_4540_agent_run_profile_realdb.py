"""story #4540 (E-DESKTOP-2 C-5) — the model and effort a desktop agent starts with.
Contract: doc «E-DESKTOP-2 C-5 — 에이전트 실행 프로필 계약» v1.1 (20764ba3).

The server keeps only what the two CLIs were measured to take (Codex effort per model · a typed-in name in one safe shape),
judged on the saved result; a change of runtime sends model and effort back to the defaults — from either path — and every
change moves the version the daemon compares. Changing is the runtime PATCH's rule from a person's own session, many at once
all or nothing. The daemon reads only its own agent's profile.
"""
from __future__ import annotations

import uuid

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

OPTIONS = "/api/v2/agent-run-profile/options"
OWN = "/api/v2/agent-run-profile"
MANY = "/api/v2/agents/run-profile"


def _one(agent) -> str:
    return f"/api/v2/agents/{agent}/run-profile"


def _key(device, i=0) -> dict:
    return {"Authorization": f"Bearer {device['agents'][i]['api_key']}", "X-Org-Id": str(ORG)}


def _code(r) -> tuple[int, str | None]:
    body = r.json()
    return r.status_code, (body.get("error") or {}).get("code") if isinstance(body, dict) else None


async def _row(agent) -> tuple | None:
    rows = await _sql(fetch=f"SELECT model, effort, version FROM agent_run_profiles WHERE member_id = '{agent}'")
    return tuple(rows[0]) if rows else None


async def _runtime(agent) -> str:
    return (await _sql(fetch=f"SELECT runtime_type FROM members WHERE id = '{agent}'"))[0][0]


async def _set_runtime(agent, runtime: str) -> None:
    await _sql(f"UPDATE members SET runtime_type = '{runtime}' WHERE id = '{agent}'")


async def test_01_the_pickers_offer_the_measured_table_and_nothing_made_up(world):
    async with _client() as c:
        r = await c.get(OPTIONS, headers=_person(OWNER))
    assert r.status_code == 200, r.text
    by = {rt["runtime"]: rt for rt in r.json()["runtimes"]}
    assert set(by) == {"claude-code", "codex"}
    claude = {m["name"]: m["efforts"] for m in by["claude-code"]["models"]}
    assert claude == {n: ["low", "medium", "high", "xhigh", "max"] for n in ("fable", "opus", "sonnet")}
    codex = {m["name"]: m["efforts"] for m in by["codex"]["models"]}
    assert codex["gpt-6-sol"][-1] == "ultra" and "ultra" not in codex["gpt-6-luna"]
    # only what starts with no question (민 19:32Z model probe): gpt-5.5 stops at a «retires» choice before a thread opens
    assert set(codex) == {"gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"}
    assert set(claude) == {"fable", "opus", "sonnet"}
    assert by["codex"]["custom_model_efforts"] == ["low", "medium", "high", "xhigh"]
    names = set(claude) | set(codex)
    assert not any("[" in n for n in names) and not {"gpt-reserve", "codex-auto-review"} & names


async def test_02_one_change_is_versioned_once_and_the_daemon_reads_only_its_own(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4540a")
        agent, other = device["agents"][0]["member_id"], device["agents"][1]["member_id"]
        await _set_runtime(agent, "claude-code")

        r = await c.put(_one(agent), json={"model": "opus", "effort": "xhigh"}, headers=_person(OWNER))
        assert r.status_code == 200, r.text
        assert (r.json()["model"], r.json()["effort"], r.json()["version"]) == ("opus", "xhigh", 1)
        again = await c.put(_one(agent), json={"model": "opus", "effort": "xhigh"}, headers=_person(OWNER))
        assert again.json()["version"] == 1  # the same PUT: nothing to restart for, no new version

        own = await c.get(OWN, headers=_key(device))
        assert own.status_code == 200, own.text
        assert {k: own.json()[k] for k in ("runtime", "model", "effort", "version")} == {
            "runtime": "claude", "model": "opus", "effort": "xhigh", "version": 1}
        assert own.json()["updated_at"]
        theirs = await c.get(OWN, headers=_key(device, 1))  # the other key sees its own agent only
        assert theirs.json()["version"] == 0 and theirs.json()["model"] is None
        assert await _row(other) is None

        back = await c.put(_one(agent), json={"model": None, "effort": None}, headers=_person(OWNER))
        assert (back.json()["model"], back.json()["effort"], back.json()["version"]) == (None, None, 2)
        assert (await c.get(OWN, headers=_person(OWNER))).status_code == 403  # a person is not a daemon


@pytest.mark.parametrize("model", [
    "opus 4", "opus\"", "'opus'", "-opus", "--dangerously-skip-permissions", "opus[1M]", "opus[1m][1m]", "opus[2m]", "[1m]", "a=b", "a;b", "a" * 65, "", "gpt-5\n",  # a trailing newline: `$` alone would let it through (fullmatch)
])
async def test_03_a_typed_in_name_that_could_be_more_than_a_name_is_refused(world, model):
    async with _client() as c:
        device = await _device(c, name=f"d4424 mac 4540b {uuid.uuid4().hex[:6]}")
        agent = device["agents"][0]["member_id"]
        await _set_runtime(agent, "claude-code")
        r = await c.put(_one(agent), json={"model": model, "effort": None}, headers=_person(OWNER))
        assert _code(r) == (422, "invalid_model")
        assert await _row(agent) is None


async def test_03b_claude_takes_its_1m_id_codex_never(world):
    # story 4540 (PO 2026-10-04 13:10Z · 13:11Z): `claude-opus-5-5[1m]` is our launchers' value — saved for Claude as typed; Codex refuses it
    async with _client() as c:
        device = await _device(c, name=f"d4424 mac 4540b2 {uuid.uuid4().hex[:6]}")
        claude, codex = device["agents"][0]["member_id"], device["agents"][1]["member_id"]
        await _set_runtime(claude, "claude-code")
        await _set_runtime(codex, "codex")
        r = await c.put(_one(claude), json={"model": "claude-opus-5-5[1m]", "effort": "xhigh"}, headers=_person(OWNER))
        assert r.status_code == 200 and (r.json()["model"], r.json()["effort"]) == ("claude-opus-5-5[1m]", "xhigh")
        r = await c.put(_one(codex), json={"model": "gpt-5.6-luna[1m]", "effort": None}, headers=_person(OWNER))
        assert _code(r) == (422, "invalid_model")
        assert await _row(codex) is None


async def test_04_effort_is_judged_per_runtime_and_model_on_the_saved_result(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4540c")
        claude, codex = device["agents"][0]["member_id"], device["agents"][1]["member_id"]
        await _set_runtime(claude, "claude-code")
        await _set_runtime(codex, "codex")
        put = lambda a, body: c.put(_one(a), json=body, headers=_person(OWNER))  # noqa: E731

        assert _code(await put(claude, {"model": "opus", "effort": "ultra"})) == (422, "invalid_effort")
        assert _code(await put(codex, {"model": "gpt-5.5", "effort": "max"})) == (422, "invalid_effort")
        assert _code(await put(codex, {"model": "my-own-model", "effort": "max"})) == (422, "invalid_effort")
        assert _code(await put(codex, {"model": None, "effort": "max"})) == (422, "invalid_effort")
        assert (await put(codex, {"model": "my-own-model", "effort": "xhigh"})).status_code == 200
        assert (await put(codex, {"model": "gpt-6-sol", "effort": "ultra"})).status_code == 200
        # a model change alone would keep «ultra», which gpt-6-luna doesn't take — refused, nothing written
        assert _code(await put(codex, {"model": "gpt-6-luna", "effort": "ultra"})) == (422, "invalid_effort")
        assert await _row(codex) == ("gpt-6-sol", "ultra", 2)
        many = await c.put(MANY, json={"agent_ids": [codex], "model": "gpt-5.5"}, headers=_person(OWNER))  # effort kept
        assert _code(many) == (422, "invalid_effort") and await _row(codex) == ("gpt-6-sol", "ultra", 2)

        await _set_runtime(claude, "opencode")
        assert _code(await put(claude, {"model": None, "effort": None})) == (422, "runtime_not_desktop")
        assert _code(await c.get(OWN, headers=_key(device))) == (409, "runtime_not_desktop")


async def test_05_a_runtime_change_from_either_path_sends_model_and_effort_back_to_defaults(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4540d")
        agent = device["agents"][0]["member_id"]
        await _set_runtime(agent, "codex")
        assert (await c.put(_one(agent), json={"model": "gpt-6-sol", "effort": "ultra"}, headers=_person(OWNER))).status_code == 200

        r = await c.put(_one(agent), json={"runtime": "claude-code", "model": None, "effort": None}, headers=_person(OWNER))
        assert (r.json()["runtime"], r.json()["model"], r.json()["effort"], r.json()["version"]) == ("claude-code", None, None, 2)
        # a Codex model given with a runtime change is judged against the new runtime's names
        assert _code(await c.put(MANY, json={"agent_ids": [agent], "runtime": "codex", "model": "gpt-6-sol", "effort": "max"},
                                 headers=_person(OWNER)))[0] == 200
        assert await _row(agent) == ("gpt-6-sol", "max", 3)
        # many at once, the runtime changed and model · effort left «as is»: the old runtime's names do not ride along
        moved = await c.put(MANY, json={"agent_ids": [agent], "runtime": "claude-code"}, headers=_person(OWNER))
        assert moved.status_code == 200, moved.text
        assert await _row(agent) == (None, None, 4)
        assert (await c.put(MANY, json={"agent_ids": [agent], "runtime": "codex", "model": "gpt-6-sol", "effort": "max"},
                            headers=_person(OWNER))).status_code == 200
        assert await _row(agent) == ("gpt-6-sol", "max", 5)

        # the web's general runtime picker (team-members PATCH) also resets them and moves the version
        p = await c.patch(f"/api/v2/team-members/{agent}", json={"runtime_type": "claude-code"}, headers=_person(OWNER))
        assert p.status_code == 200, p.text
        assert await _row(agent) == (None, None, 6) and await _runtime(agent) == "claude-code"
        own = await c.get(OWN, headers=_key(device))
        assert (own.json()["runtime"], own.json()["model"], own.json()["version"]) == ("claude", None, 6)


async def test_06_many_at_once_only_among_one_runtime_and_all_or_nothing(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4540e")
        a, b = device["agents"][0]["member_id"], device["agents"][1]["member_id"]
        await _set_runtime(a, "claude-code")
        await _set_runtime(b, "codex")

        mixed = await c.put(MANY, json={"agent_ids": [a, b], "effort": "high"}, headers=_person(OWNER))
        assert _code(mixed) == (422, "mixed_runtime")
        assert await _row(a) is None and await _row(b) is None
        # the runtime itself may be set for a mixed group — then both share it
        same = await c.put(MANY, json={"agent_ids": [a, b], "runtime": "claude-code", "effort": "high"}, headers=_person(OWNER))
        assert same.status_code == 200, same.text
        assert [(p["runtime"], p["effort"]) for p in same.json()["profiles"]] == [("claude-code", "high")] * 2

        # one agent the caller may not change: nobody's row moves
        before = (await _row(a), await _row(b))
        plain_tm = (await _sql(fetch=f"SELECT id FROM org_members WHERE org_id = '{ORG}' AND user_id = '{PLAIN}'"))[0][0]
        await _sql(f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES ('{plain_tm}','{ORG}','{PLAIN}','human','Plain',true)")
        denied = await c.put(MANY, json={"agent_ids": [a, b], "effort": "low"}, headers=_person(PLAIN))
        assert denied.status_code == 403
        assert (await _row(a), await _row(b)) == before
        # rights are checked for EVERY agent before anything is written: PLAIN's own agent first, someone else's after → 403, the
        # first one is not written either (까디르 4943 ①)
        await _sql(f"UPDATE members SET owner_member_id = '{plain_tm}' WHERE id = '{a}'")
        assert (await c.put(_one(a), json={"model": None, "effort": "high"}, headers=_person(PLAIN))).status_code == 200  # a is PLAIN's
        mine_first = (await _row(a), await _row(b))
        late = await c.put(MANY, json={"agent_ids": [a, b], "effort": "low"}, headers=_person(PLAIN))
        assert late.status_code == 403
        assert (await _row(a), await _row(b)) == mine_first

        too_many = await c.put(MANY, json={"agent_ids": [str(uuid.uuid4()) for _ in range(51)]}, headers=_person(OWNER))
        assert _code(too_many) == (422, "invalid_agent_ids")
        assert _code(await c.put(MANY, json={"agent_ids": []}, headers=_person(OWNER))) == (422, "invalid_agent_ids")


async def test_07_who_may_read_and_change(world):
    from app.core.database import async_session_factory
    from app.repositories.human_api_key import HumanApiKeyRepository

    async with _client() as c:
        device = await _device(c, name="d4424 mac 4540f")
        agent = device["agents"][0]["member_id"]
        await _set_runtime(agent, "claude-code")
        plain_tm = (await _sql(fetch=f"SELECT id FROM org_members WHERE org_id = '{ORG}' AND user_id = '{PLAIN}'"))[0][0]
        await _sql(f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES ('{plain_tm}','{ORG}','{PLAIN}','human','Plain',true)")

        assert (await c.get(_one(agent), headers=_person(OWNER))).json()["can_change"] is True
        seen = await c.get(_one(agent), headers=_person(PLAIN))
        assert seen.status_code == 200 and seen.json()["can_change"] is False
        assert (await c.put(_one(agent), json={"model": "opus", "effort": None}, headers=_person(PLAIN))).status_code == 403

        async with async_session_factory() as s:
            _k, plaintext = await HumanApiKeyRepository(s).create(member_id=OWNER_TM, name="d4540 script", expires_at=None)
            await s.commit()
        try:
            for headers in ({"Authorization": f"Bearer {plaintext}", "X-Org-Id": str(ORG)}, _key(device)):
                r = await c.put(_one(agent), json={"model": "opus", "effort": None}, headers=headers)
                assert _code(r) == (403, "person_session_required")
                r = await c.put(MANY, json={"agent_ids": [agent], "effort": "low"}, headers=headers)
                assert _code(r) == (403, "person_session_required")
        finally:
            await _sql(f"DELETE FROM human_api_keys WHERE member_id = '{OWNER_TM}'")
        assert _code(await c.get(_one(agent), headers=_key(device)))[0] == 403  # an agent key reads only through /agent-run-profile
        assert await _row(agent) is None

        # another org's admin: the agent is not there for them
        assert (await c.get(_one(agent), headers=_person(OUTSIDER))).status_code in (403, 404)
        assert (await c.put(_one(agent), json={"model": "opus", "effort": None}, headers=_person(OUTSIDER))).status_code in (403, 404)

        # the system agent is never changed
        await _set_runtime(agent, "system-publisher")
        r = await c.put(_one(agent), json={"model": None, "effort": None}, headers=_person(OWNER))
        assert _code(r) == (409, "SYSTEM_PUBLISHER_RESERVED")
        assert (await c.get(_one(agent), headers=_person(OWNER))).json()["can_change"] is False
