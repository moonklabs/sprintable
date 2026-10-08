"""story #4629 (2선 · 4624 후속 · PO 09:02Z: A2) — [이 폰 빼기] also ends that phone's own login session, and no other.

Before: removing a lost phone's key left its login alive (the whole account open on it) and the same key could come back. Now the
phone's registration records the refresh token it was logged in with (the row id, found by hash · the raw token never kept), and
removing the key follows that token's rotation chain to the live end and revokes it. A key with no recorded session (registered
before 0446 · no token sent) ends nothing (PO: no other session is touched to make up for it) — the answer says `not_found`.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
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
from tests.test_4533_agent_permissions_realdb import (  # noqa: F401 — autouse: remote control on for ORG
    PHONES,
    _phone_key,
    _remote_control_on,
)

pytestmark = pytest.mark.anyio


@pytest.fixture(autouse=True)
def _no_rate_limit(monkeypatch):
    from app.core.rate_limit import limiter

    monkeypatch.setattr(limiter, "enabled", False)


async def _login(user: uuid.UUID) -> str:
    """A refresh token of the person, stored as a login stores it (the hash · its expiry) — one session."""
    from app.core.security import create_refresh_token, hash_token

    raw, exp = create_refresh_token(str(user))
    await _sql(
        f"INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES "
        f"('{uuid.uuid4()}', '{user}', '{hash_token(raw)}', '{exp.isoformat()}', '{datetime.now(timezone.utc).isoformat()}')"
    )
    return raw


async def _refresh(c, raw: str):
    return await c.post("/api/v2/auth/refresh", json={"refresh_token": raw})


async def _register(c, who=OWNER, rt: str | None = None) -> str:
    key, _der = _phone_key()
    body = {"label": "잃은 폰", "public_key": key, **({"refresh_token": rt} if rt else {})}
    r = await c.post(PHONES, json=body, headers=_person(who))
    assert r.status_code == 201, r.text
    assert "refresh_token" not in r.text, "the token is never echoed back"
    return r.json()["id"]


async def test_01_removing_the_phone_ends_its_session_and_only_its(world):
    async with _client() as c:
        phone_rt = await _login(OWNER)
        other_rt = await _login(OWNER)  # the same person on the Mac
        phone = await _register(c, rt=phone_rt)
        gone = await c.delete(f"{PHONES}/{phone}", headers=_person(OWNER))
        assert gone.status_code == 200 and gone.json() == {"removed": True, "session": "ended"}
        assert (await _refresh(c, phone_rt)).status_code == 401, "the lost phone's login is over"
        assert (await _refresh(c, other_rt)).status_code == 200, "the Mac's session is untouched"


async def test_02_after_the_phone_refreshed_twice_the_live_end_of_its_chain_is_ended(world):
    async with _client() as c:
        first = await _login(OWNER)
        phone = await _register(c, rt=first)
        r1 = await _refresh(c, first)
        assert r1.status_code == 200
        r2 = await _refresh(c, r1.json()["data"]["refresh_token"])
        assert r2.status_code == 200
        live = r2.json()["data"]["refresh_token"]
        assert (await c.delete(f"{PHONES}/{phone}", headers=_person(OWNER))).json()["session"] == "ended"
        assert (await _refresh(c, live)).status_code == 401, "the token it holds now — two rotations after the one it registered with"


async def test_03_a_key_with_no_recorded_session_ends_nothing_and_says_so(world):
    async with _client() as c:
        rt = await _login(OWNER)
        phone = await _register(c)  # registered before 0446 · or no token sent
        gone = await c.delete(f"{PHONES}/{phone}", headers=_person(OWNER))
        assert gone.json() == {"removed": True, "session": "not_found"}
        assert (await _refresh(c, rt)).status_code == 200, "no session of the person is ended to make up for it"
        # a session that ended on its own before the removal: not_found too, nothing else touched
        rt2 = await _login(OWNER)
        phone2 = await _register(c, rt=rt2)
        assert (await c.post("/api/v2/auth/logout", json={"refresh_token": rt2})).status_code == 200
        assert (await c.delete(f"{PHONES}/{phone2}", headers=_person(OWNER))).json()["session"] == "not_found"
        assert (await _refresh(c, rt)).status_code == 200


async def test_04_another_persons_token_binds_nothing_and_the_raw_token_is_kept_nowhere(world):
    async with _client() as c:
        plains = await _login(PLAIN)
        phone = await _register(c, who=OWNER, rt=plains)  # someone's token sent with OWNER's registration
        assert (await _sql(fetch=f"SELECT session_token_id FROM remote_devices WHERE id = '{phone}'"))[0][0] is None
        assert (await c.delete(f"{PHONES}/{phone}", headers=_person(OWNER))).json()["session"] == "not_found"
        assert (await _refresh(c, plains)).status_code == 200, "the other person's session lives on"
        # the raw token appears in no column of the key row
        own = await _login(OWNER)
        phone2 = await _register(c, rt=own)
        row = (await _sql(fetch=f"SELECT row_to_json(r)::text FROM remote_devices r WHERE id = '{phone2}'"))[0][0]
        assert own not in row


async def test_05_registering_the_same_key_again_from_a_new_login_moves_the_session(world):
    async with _client() as c:
        old_rt = await _login(OWNER)
        key, _der = _phone_key()
        first = await c.post(PHONES, json={"label": "폰", "public_key": key, "refresh_token": old_rt}, headers=_person(OWNER))
        assert first.status_code == 201
        new_rt = await _login(OWNER)  # logged in again on the same phone
        again = await c.post(PHONES, json={"label": "폰", "public_key": key, "refresh_token": new_rt}, headers=_person(OWNER))
        assert again.status_code == 200 and again.json()["id"] == first.json()["id"]
        assert (await c.delete(f"{PHONES}/{first.json()['id']}", headers=_person(OWNER))).json()["session"] == "ended"
        assert (await _refresh(c, new_rt)).status_code == 401, "the latest login is the one ended"
