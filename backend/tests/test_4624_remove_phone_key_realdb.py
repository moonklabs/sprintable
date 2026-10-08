"""story #4624 (1선 · PO 07:58Z) — [이 폰 빼기]: the phone key itself can be removed.

Before: nothing set `remote_devices.revoked_at` (only read in 8 places); the limit counts live keys (PHONES_PER_PERSON = 3), so a
phone reinstalled three times held three live keys for good, and the advice «원격 기기에서 하나를 빼 주세요» could only remove pairs.
Now `DELETE /api/v2/remote-devices/{id}`: its owner or an owner/admin of its org · revoked_at set · every live pair removed the
[빼기] way (`pairing_removed` goes down) · idempotent · anyone else 404 · the same key registered again by its owner comes back.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    ORG2,
    OUTSIDER,
    OWNER,
    PLAIN,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device, _tok
from tests.test_4533_agent_permissions_realdb import (  # noqa: F401 — autouse: remote control on for ORG
    PHONES,
    REQS,
    _answer,
    _ask,
    _fp,
    _pair,
    _phone_key,
    _plain_member,
    _post_ask,
    _register,
    _remote_control_on,
    _with_session,
)

pytestmark = pytest.mark.anyio


async def _live(phone_id: str) -> bool:
    return (await _sql(fetch=f"SELECT revoked_at IS NULL FROM remote_devices WHERE id = '{phone_id}'"))[0][0]


async def test_01_removing_a_key_frees_its_place_under_the_limit_and_is_idempotent(world):
    async with _client() as c:
        ids = [(await _register(c, label=f"폰 {i}"))[0] for i in range(3)]
        key, _der = _phone_key()
        full = await c.post(PHONES, json={"label": "넷째", "public_key": key}, headers=_person(OWNER))
        assert full.status_code == 409 and full.json()["error"]["code"] == "remote_device_limit"
        gone = await c.delete(f"{PHONES}/{ids[0]}", headers=_person(OWNER))
        assert gone.status_code == 200 and gone.json() == {"removed": True}
        assert not await _live(ids[0])
        assert [d["id"] for d in (await c.get(PHONES, headers=_person(OWNER))).json()["devices"]] == ids[1:], "gone from the list"
        again = await c.post(PHONES, json={"label": "넷째", "public_key": key}, headers=_person(OWNER))
        assert again.status_code == 201, "the place is free: the fourth registers"
        twice = await c.delete(f"{PHONES}/{ids[0]}", headers=_person(OWNER))
        assert twice.status_code == 200 and twice.json() == {"removed": False}


async def test_02_its_pairs_go_with_it_at_once_and_an_answer_signed_by_it_is_refused(world, monkeypatch):
    import app.routers.desktop_relay as router_mod

    monkeypatch.setattr(router_mod, "_LIFESPAN_SEC", 0.3)
    monkeypatch.setattr(router_mod, "_LIFESPAN_JITTER_SEC", 0)
    async with _client() as c:
        a = await _device(c, name="d4424 mac 4624a")
        b = await _device(c, name="d4424 mac 4624b")
        agent = await _with_session(c, a)
        phone_id, der = await _register(c)
        at = datetime.now(timezone.utc) - timedelta(minutes=5)
        await _pair(c, a["device_token"], der, at=at)
        await _pair(c, b["device_token"], der, at=at)
        view = (await _post_ask(c, a, _ask(agent))).json()

        # an open stream hears it now, not at its next reconnect: each paired setup is woken (recorded — a fresh GET below would
        # read the removal at connect even without a wake)
        import app.services.agent_permissions as perms

        woken: list[str] = []
        real_wake = perms._wake_device_after_commit
        monkeypatch.setattr(perms, "_wake_device_after_commit", lambda db, sid: (woken.append(str(sid)), real_wake(db, sid))[1])
        assert (await c.delete(f"{PHONES}/{phone_id}", headers=_person(OWNER))).json() == {"removed": True}
        assert sorted(woken) == sorted([a["setup_id"], b["setup_id"]]), woken
        live_pairs = (await _sql(fetch=f"SELECT count(*) FROM remote_device_pairings WHERE remote_device_id = '{phone_id}' AND removed_at IS NULL"))[0][0]
        assert live_pairs == 0, "both pairs removed with the key"
        refused = await c.post(f"{REQS}/{view['id']}/answer", json=_answer(phone_id), headers=_person(OWNER))
        assert (refused.status_code, refused.json()["error"]["code"]) == (409, "phone_not_paired"), refused.text  # a live key with a live pair only
        frame = 'event: pairing_removed\ndata: {"phone_key_fingerprint": "%s"}' % _fp(der)
        for d in (a, b):
            assert frame in (await c.get("/api/v2/desktop/relay/stream", headers=_tok(d["device_token"]))).text, "each setup is told"


async def test_03_only_its_owner_or_an_org_admin_and_anyone_else_sees_404(world):
    async with _client() as c:
        owners, _der = await _register(c)  # OWNER is the org's owner
        await _plain_member()
        plains, _der2 = await _register(c, who=PLAIN)
        # a plain member: never another person's key — the same 404 as a key that does not exist
        r = await c.delete(f"{PHONES}/{owners}", headers=_person(PLAIN))
        assert r.status_code == 404 and r.json()["error"]["code"] == "phone_not_found"
        assert await _live(owners)
        # someone of another org (an admin there) naming this org: refused before the route (not a member) — nothing changed
        r = await c.delete(f"{PHONES}/{owners}", headers=_person(OUTSIDER))
        assert r.status_code == 403, r.text
        assert await _live(owners)
        # the same person in their own org: the key is not in it — the same 404
        r = await c.delete(f"{PHONES}/{owners}", headers=_person(OUTSIDER, ORG2))
        assert r.status_code == 404 and r.json()["error"]["code"] == "phone_not_found", r.text
        assert await _live(owners)
        # the plain member's own key: yes · the org's owner removing a member's key: yes
        assert (await c.delete(f"{PHONES}/{plains}", headers=_person(PLAIN))).json() == {"removed": True}
        await _sql(f"UPDATE remote_devices SET revoked_at = NULL WHERE id = '{plains}'")
        assert (await c.delete(f"{PHONES}/{plains}", headers=_person(OWNER))).json() == {"removed": True}


async def test_04_the_same_key_registered_again_by_its_owner_comes_back(world):
    async with _client() as c:
        key, _der = _phone_key()
        first = await c.post(PHONES, json={"label": "iPhone", "public_key": key}, headers=_person(OWNER))
        phone_id = first.json()["id"]
        await c.delete(f"{PHONES}/{phone_id}", headers=_person(OWNER))
        back = await c.post(PHONES, json={"label": "iPhone 다시", "public_key": key}, headers=_person(OWNER))
        assert back.status_code == 201 and back.json()["id"] == phone_id and await _live(phone_id)
