"""story #4583 — the «원격 제어 꺼짐» state names who can turn it on, and says whether a computer is connected (Yuna `4583/copy.md`).

The two new fields, pinned (PO 04:09Z · Kadir's lens «what the new fields show, and to whom»):
- `owner_names`: display names only — no email · no member id · no user id.
- `connected_computers`: a count only — no device name.
- The person-session read answers only a person of that org — anyone else gets resolve_member's own 400 (unchanged · PO 05:08Z:
  the shared resolver's status is outside this story) with **no name in the body**; the device read (an agent key) answers only
  its own org's names.
- «Owner» is read where the PUT gate reads it, on both resolver branches (Didi R2); `connected_computers` counts the devices turning
  it on would wake (Didi R4 · `_live_devices`).
- Unchanged: the switch starts off, and only an owner's person session changes it (4535's tests).
"""
from __future__ import annotations

import re
import uuid

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    ORG2,
    OUTSIDER,
    OWNER,
    OWNER_TM,
    PLAIN,
    _addresses,
    _client,
    _code,
    _confirm,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device

pytestmark = pytest.mark.anyio

URL = f"/api/v2/organizations/{ORG}/remote-control"
DEVICE_URL = "/api/v2/desktop/remote-control"
UUID_SHAPE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)


def _no_identity(names: list) -> None:
    for n in names:
        assert isinstance(n, str) and "@" not in n and not UUID_SHAPE.search(n), n


async def test_the_answer_carries_exactly_five_keys_and_names_the_owner_to_everyone_in_the_org(world):
    async with _client() as c:
        for who, can in ((OWNER, True), (PLAIN, False)):
            body = (await c.get(URL, headers=_person(who))).json()
            assert set(body) == {"enabled", "enabled_at", "can_change", "owner_names", "connected_computers"}, body
            assert body["can_change"] is can
            assert body["owner_names"] == ["Owner"], "a person who is not an owner reads the owner's name"
            _no_identity(body["owner_names"])
            assert isinstance(body["connected_computers"], int)


async def _count(c) -> int:
    return (await c.get(URL, headers=_person(PLAIN))).json()["connected_computers"]


async def test_connected_computers_counts_only_what_turning_it_on_would_wake(world):
    async with _client() as c:
        assert await _count(c) == 0
        await _device(c, name="d4424 mac 4583a")
        await _device(c, name="d4424 mac 4583b")
        assert await _count(c) == 2
        # confirmed on the web, but the app never picked the keys up: nothing to wake → not counted
        code, _verifier = await _code(c, "d4424 mac 4583c")
        assert (await _confirm(c, code)).status_code == 200
        assert await _count(c) == 2
        # disconnected → not counted
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE org_id = '{ORG}' AND device_name = 'd4424 mac 4583a'")
        assert await _count(c) == 1
        # another org's live device → not counted here
        await _sql(f"UPDATE desktop_setups SET org_id = '{ORG2}' WHERE org_id = '{ORG}' AND device_name = 'd4424 mac 4583b'")
        body = (await c.get(URL, headers=_person(PLAIN))).json()
        assert body["connected_computers"] == 0
        assert "d4424 mac" not in str(body), "a count only — no device name"


async def test_another_orgs_person_gets_the_resolvers_400_with_no_name_in_it(world):
    async with _client() as c:
        r = await c.get(URL, headers=_person(OUTSIDER))
        assert r.status_code == 400, r.text  # resolve_member's own (PO 05:08Z: unchanged — not this story's)
        assert "Owner" not in r.text and "owner_names" not in r.text and "connected_computers" not in r.text


async def test_owner_names_are_who_the_put_gate_lets_turn_it_on_on_both_resolver_branches(world, monkeypatch):
    from app.core.config import settings

    async with _client() as c:
        # legacy branch (default): org_members.role
        assert (await c.get(URL, headers=_person(PLAIN))).json()["owner_names"] == ["Owner"]
        assert (await c.put(URL, json={"enabled": False}, headers=_person(OWNER))).status_code == 200
        # anchor branch: members.org_role — the gate reads it there, so the names do too
        monkeypatch.setattr(settings, "member_ssot_resolver_shadow", True)
        await _sql(f"UPDATE members SET org_role = 'owner' WHERE id = '{OWNER_TM}'")
        assert (await c.get(URL, headers=_person(PLAIN))).json()["owner_names"] == ["Owner"]
        assert (await c.put(URL, json={"enabled": False}, headers=_person(OWNER))).status_code == 200
        # not an owner on the branch in use → not named (and the gate refuses them)
        await _sql(f"UPDATE members SET org_role = 'member' WHERE id = '{OWNER_TM}'")
        assert (await c.get(URL, headers=_person(PLAIN))).json()["owner_names"] == []
        assert (await c.put(URL, json={"enabled": False}, headers=_person(OWNER))).status_code == 403


async def test_an_owner_without_a_name_row_or_inactive_is_left_out_never_shown_as_an_id(world):
    nameless = uuid.uuid4()
    await _sql(
        f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) "
        f"VALUES ('{nameless}','nameless@d4583.test','x','Nameless',true,true,0,false,0)"
    )
    await _sql(f"INSERT INTO org_members (id,org_id,user_id,role) VALUES (gen_random_uuid(),'{ORG}','{nameless}','owner')")
    async with _client() as c:
        names = (await c.get(URL, headers=_person(PLAIN))).json()["owner_names"]
        assert names == ["Owner"], names
        _no_identity(names)
        await _sql(f"UPDATE members SET is_active = false WHERE id = '{OWNER_TM}'")
        assert (await c.get(URL, headers=_person(PLAIN))).json()["owner_names"] == [], "an inactive owner is not named"
        # the edge pinned as the meant behaviour (Kadir 4973 · PO 06:06Z): the gate still lets both turn it on — the list names
        # only those it can show, it does not decide who may change it (an inactive member at the gate is 4535's, not this card's)
        assert (await c.put(URL, json={"enabled": True}, headers=_person(OWNER))).status_code == 200, "inactive owner: the gate as today"
        assert (await c.put(URL, json={"enabled": False}, headers=_person(nameless))).status_code == 200, "nameless owner: the gate as today"
        body = (await c.get(URL, headers=_person(PLAIN))).json()
        assert body["owner_names"] == [] and body["can_change"] is False


async def test_the_device_reads_only_its_own_orgs_owner_names(world):
    other_owner = uuid.uuid4()
    other_tm = uuid.uuid4()
    await _sql(
        f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) "
        f"VALUES ('{other_owner}','other@d4583.test','x','Other Owner',true,true,0,false,0)"
    )
    await _sql(f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{other_tm}','{ORG2}','{other_owner}','owner')")
    await _sql(f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES ('{other_tm}','{ORG2}','{other_owner}','human','Other Owner',true)")
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4583d")
        key = {"Authorization": f"Bearer {device['agents'][0]['api_key']}"}
        body = (await c.get(DEVICE_URL, headers=key)).json()
        assert set(body) == {"enabled", "owner_names"}, body
        assert body["owner_names"] == ["Owner"], "its own org only — never another org's owner"
        _no_identity(body["owner_names"])
