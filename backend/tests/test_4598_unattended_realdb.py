"""story #4598 (E-DESKTOP-2 · 1선 · PO 10:53Z · contract `~/.sprintable-shared/mirko/4598-unattended-contract.md` v0.1 §1 · §4) —
«묻지 않고 일하기» (`agent_run_profiles.unattended`, alembic 0441): one switch per agent, an org owner's only.

- An owner flips it → 200 · the version moves once · the daemon's own read shows it. The same value again moves no version.
- An admin (may change model · effort) flips it → 403 `owner_required`, nothing written — even when the same body changes the model
  (all or nothing). An admin's body that carries the switch at its current value changes nothing of it → the model change goes through.
- A deactivated owner is not an owner for this. Many at once take it like the other fields (`keep` = as it is).
- `_bump` (an allowed host removed) keeps the flag · a runtime change keeps the flag (model · effort go back, the switch does not).
- `GET /agents/{id}/run-profile`: `can_change_unattended` — owner true · admin false.
Mutation (local): the owner check removed → RED. The `desktop.run_profile` trigger (4977) is not in develop yet — this writes through
`_save`, so it rides along when 4977 lands; not asserted here.
"""
from __future__ import annotations

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
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
from tests.test_4540_agent_run_profile_realdb import MANY, OWN, _code, _key, _one, _set_runtime

pytestmark = pytest.mark.anyio


async def _flag(agent) -> tuple | None:
    rows = await _sql(fetch=f"SELECT unattended, version, model FROM agent_run_profiles WHERE member_id = '{agent}'")
    return tuple(rows[0]) if rows else None


async def _make_admin() -> str:
    """PLAIN becomes an org admin with a members row — may change model · effort (the runtime PATCH's rule) but is not an owner."""
    plain_tm = (await _sql(fetch=f"SELECT id FROM org_members WHERE org_id = '{ORG}' AND user_id = '{PLAIN}'"))[0][0]
    await _sql(
        f"UPDATE org_members SET role = 'admin' WHERE id = '{plain_tm}'",
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES ('{plain_tm}','{ORG}','{PLAIN}','human','Plain',true)",
    )
    return plain_tm


async def test_01_an_owner_flips_it_once_and_the_daemon_reads_it(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4598a")
        agent = device["agents"][0]["member_id"]
        await _set_runtime(agent, "claude-code")

        seen = await c.get(_one(agent), headers=_person(OWNER))
        assert seen.status_code == 200, seen.text
        assert (seen.json()["unattended"], seen.json()["can_change_unattended"], seen.json()["version"]) == (False, True, 0)
        assert (await c.get(OWN, headers=_key(device))).json()["unattended"] is False  # no row yet → off

        on = await c.put(_one(agent), json={"model": None, "effort": None, "unattended": True}, headers=_person(OWNER))
        assert on.status_code == 200, on.text
        assert (on.json()["unattended"], on.json()["version"], on.json()["can_change_unattended"]) == (True, 1, True)
        assert await _flag(agent) == (True, 1, None)
        own = await c.get(OWN, headers=_key(device))
        assert own.status_code == 200 and (own.json()["unattended"], own.json()["version"]) == (True, 1)

        again = await c.put(_one(agent), json={"model": None, "effort": None, "unattended": True}, headers=_person(OWNER))
        assert again.json()["version"] == 1  # the same value: nothing to restart for
        absent = await c.put(_one(agent), json={"model": None, "effort": None}, headers=_person(OWNER))
        assert (absent.json()["unattended"], absent.json()["version"]) == (True, 1)  # absent = as it is

        off = await c.put(_one(agent), json={"model": "opus", "effort": None, "unattended": False}, headers=_person(OWNER))
        assert (off.json()["unattended"], off.json()["model"], off.json()["version"]) == (False, "opus", 2)
        assert await _flag(agent) == (False, 2, "opus")


async def test_02_an_admin_may_not_flip_it_and_nothing_else_in_that_body_is_written(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4598b")
        agent = device["agents"][0]["member_id"]
        await _set_runtime(agent, "claude-code")
        await _make_admin()

        seen = await c.get(_one(agent), headers=_person(PLAIN))
        assert seen.status_code == 200 and (seen.json()["can_change"], seen.json()["can_change_unattended"]) == (True, False)

        # the admin may change the model — proven first, so the 403 below is about the switch and nothing else
        ok = await c.put(_one(agent), json={"model": "opus", "effort": None}, headers=_person(PLAIN))
        assert ok.status_code == 200, ok.text
        assert ok.json()["can_change_unattended"] is False
        assert await _flag(agent) == (False, 1, "opus")

        denied = await c.put(_one(agent), json={"model": "sonnet", "effort": None, "unattended": True}, headers=_person(PLAIN))
        assert _code(denied) == (403, "owner_required")
        assert await _flag(agent) == (False, 1, "opus")  # all or nothing: the model change did not land either

        # the switch at its current value is not a change of it — the model change goes through
        same = await c.put(_one(agent), json={"model": "sonnet", "effort": None, "unattended": False}, headers=_person(PLAIN))
        assert same.status_code == 200, same.text
        assert await _flag(agent) == (False, 2, "sonnet")

        # many at once: the same rule, nothing written
        other = device["agents"][1]["member_id"]
        await _set_runtime(other, "claude-code")
        many = await c.put(MANY, json={"agent_ids": [agent, other], "unattended": True}, headers=_person(PLAIN))
        assert _code(many) == (403, "owner_required")
        assert await _flag(agent) == (False, 2, "sonnet") and await _flag(other) is None


async def test_03_a_deactivated_owner_is_not_an_owner_for_this(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4598c")
        agent = device["agents"][0]["member_id"]
        await _set_runtime(agent, "claude-code")
        await _sql(f"UPDATE members SET is_active = false WHERE id = '{OWNER_TM}'")
        try:
            seen = await c.get(_one(agent), headers=_person(OWNER))
            assert seen.status_code == 200 and seen.json()["can_change_unattended"] is False
            denied = await c.put(_one(agent), json={"model": None, "effort": None, "unattended": True}, headers=_person(OWNER))
            assert _code(denied) == (403, "owner_required")
            assert await _flag(agent) is None
        finally:
            await _sql(f"UPDATE members SET is_active = true WHERE id = '{OWNER_TM}'")
        assert (await c.put(_one(agent), json={"model": None, "effort": None, "unattended": True}, headers=_person(OWNER))).status_code == 200


async def test_03b_an_owner_row_without_a_live_members_row_is_not_an_owner_for_this(world):
    """Kadir qa:changes (4980 ①): the check fails closed. An org owner (org_members.role = owner) whose members row is missing, or
    soft-deleted, is refused like a deactivated one — 403 and nothing written; `can_change_unattended` false. `members.is_active`
    cannot be NULL at all (the column is NOT NULL — pinned here, so «NULL counts as active» has no row to stand on)."""
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4598c2")
        agent = device["agents"][0]["member_id"]
        await _set_runtime(agent, "claude-code")
        [(nullable,)] = await _sql(fetch="SELECT is_nullable FROM information_schema.columns WHERE table_name = 'members' AND column_name = 'is_active'")
        assert nullable == "NO", "is_active has no NULL to fail open on"
        plain_om = (await _sql(fetch=f"SELECT id, role FROM org_members WHERE org_id = '{ORG}' AND user_id = '{PLAIN}'"))[0]
        plain_tm, plain_role = plain_om[0], plain_om[1]
        try:
            # ① an owner by org_members alone — no members row at all
            await _sql(f"UPDATE org_members SET role = 'owner' WHERE id = '{plain_tm}'")
            assert (await c.get(_one(agent), headers=_person(PLAIN))).json()["can_change_unattended"] is False
            denied = await c.put(_one(agent), json={"model": None, "effort": None, "unattended": True}, headers=_person(PLAIN))
            assert _code(denied) == (403, "owner_required")
            assert await _flag(agent) is None
            # ② a members row that was soft-deleted
            await _sql(f"INSERT INTO members (id,org_id,user_id,type,name,is_active,deleted_at) VALUES ('{plain_tm}','{ORG}','{PLAIN}','human','Plain',true,now())")
            assert (await c.get(_one(agent), headers=_person(PLAIN))).json()["can_change_unattended"] is False
            denied = await c.put(_one(agent), json={"model": None, "effort": None, "unattended": True}, headers=_person(PLAIN))
            assert _code(denied) == (403, "owner_required")
            assert await _flag(agent) is None
            # ③ the same row live again — now an owner for this
            await _sql(f"UPDATE members SET deleted_at = NULL WHERE id = '{plain_tm}'")
            assert (await c.get(_one(agent), headers=_person(PLAIN))).json()["can_change_unattended"] is True
            assert (await c.put(_one(agent), json={"model": None, "effort": None, "unattended": True}, headers=_person(PLAIN))).status_code == 200
            assert (await _flag(agent))[0] is True
        finally:
            await _sql(f"DELETE FROM members WHERE id = '{plain_tm}'", f"UPDATE org_members SET role = '{plain_role}' WHERE id = '{plain_tm}'")


async def test_04_many_at_once_and_what_keeps_the_flag(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4598d")
        a, b = device["agents"][0]["member_id"], device["agents"][1]["member_id"]
        await _set_runtime(a, "claude-code")
        await _set_runtime(b, "claude-code")

        many = await c.put(MANY, json={"agent_ids": [a, b], "unattended": True}, headers=_person(OWNER))
        assert many.status_code == 200, many.text
        assert [p["unattended"] for p in many.json()["profiles"]] == [True, True]
        assert await _flag(a) == (True, 1, None) and await _flag(b) == (True, 1, None)

        kept = await c.put(MANY, json={"agent_ids": [a, b], "effort": "high"}, headers=_person(OWNER))  # unattended absent = keep
        assert kept.status_code == 200 and [p["unattended"] for p in kept.json()["profiles"]] == [True, True]
        assert (await _flag(a))[:2] == (True, 2)
        explicit = await c.put(MANY, json={"agent_ids": [a], "unattended": "keep", "effort": "low"}, headers=_person(OWNER))
        assert explicit.status_code == 200 and (await _flag(a))[:2] == (True, 3)
        assert _code(await c.put(MANY, json={"agent_ids": [a], "unattended": "yes"}, headers=_person(OWNER))) == (422, "invalid_unattended")

        # a runtime change sends model · effort back to the defaults — the switch is not a runtime word, it stays
        moved = await c.put(_one(a), json={"runtime": "codex", "model": None, "effort": None}, headers=_person(OWNER))
        assert moved.status_code == 200 and (moved.json()["runtime"], moved.json()["unattended"], moved.json()["version"]) == ("codex", True, 4)
        p = await c.patch(f"/api/v2/team-members/{a}", json={"runtime_type": "claude-code"}, headers=_person(OWNER))
        assert p.status_code == 200, p.text
        assert await _flag(a) == (True, 5, None)

        # _bump (an allowed host removed) moves the version and keeps the flag
        await _sql(f"INSERT INTO agent_allowed_hosts (member_id, host) VALUES ('{a}', 'api.example.com')")
        gone = await c.delete(_one(a) + "/allowed-hosts/api.example.com", headers=_person(OWNER))
        assert gone.status_code == 200 and gone.json()["removed"] is True
        assert await _flag(a) == (True, 6, None)
        assert (await c.get(OWN, headers=_key(device))).json()["unattended"] is True
