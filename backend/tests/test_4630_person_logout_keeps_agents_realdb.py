"""story #4630 [BE 확인 · 디디] (PO 09:10Z · Didi's test, run through the real hands — Minh) — ending a person's sign-ins (the
password reset · [다른 기기에서 모두 로그아웃]) leaves what the desktop and the phone run on.

Pinned here so the confirmation window may say «데스크톱 앱의 에이전트는 그대로 일하고, 폰은 다시 로그인하면 짝이 그대로예요»
(Yuna): after the reset or «sign out everywhere else» —
- the desktop agents keep working: they use their own agent API keys (`sk_live_`), not the person's login;
- the daemon's device line keeps working: the setup's device token (`desktop_device_tokens`);
- the person's own API keys (`hu_live_`) keep working;
- the phone key and its pairing stay (no new pairing needed) — the phone app itself must log in again to answer (an answer
  needs the person's own session · 4533).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    OWNER,
    OWNER_TM,
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
    _fp,
    _pair,
    _register,
    _remote_control_on,
)

pytestmark = pytest.mark.anyio


@pytest.fixture(autouse=True)
def _no_rate_limit(monkeypatch):
    from app.core.rate_limit import limiter

    monkeypatch.setattr(limiter, "enabled", False)


async def _login(user: uuid.UUID) -> str:
    from app.core.security import create_refresh_token, hash_token

    raw, exp = create_refresh_token(str(user))
    await _sql(
        f"INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES "
        f"('{uuid.uuid4()}', '{user}', '{hash_token(raw)}', '{exp.isoformat()}', '{datetime.now(timezone.utc).isoformat()}')"
    )
    return raw


async def _reset_link_token(user: uuid.UUID) -> str:
    from app.core.security import create_password_reset_token

    hashed = (await _sql(fetch=f"SELECT hashed_password FROM users WHERE id = '{user}'"))[0][0]
    return create_password_reset_token(str(user), hashed)


@pytest.mark.parametrize("hand", ["reset-password", "logout-others"])
async def test_ending_the_persons_sign_ins_leaves_agents_device_line_person_keys_and_phone_pairs(world, hand):
    from app.core.database import async_session_factory
    from app.repositories.human_api_key import HumanApiKeyRepository

    async with async_session_factory() as s:
        _hkey, person_key = await HumanApiKeyRepository(s).create(member_id=OWNER_TM, name="d4630 script", expires_at=None)
        await s.commit()
    try:
        async with _client() as c:
            device = await _device(c, name="d4424 mac 4630")
            agent_key = device["agents"][0]["api_key"]
            phone_id, der = await _register(c)
            await _pair(c, device["device_token"], der)
            browser, phone_app = await _login(OWNER), await _login(OWNER)

            if hand == "reset-password":  # from the mailed link, signed out: every sign-in ends
                r = await c.post("/api/v2/auth/reset-password", json={"token": await _reset_link_token(OWNER), "new_password": "Reset-pass-4630!"})
                assert r.status_code == 200 and r.json()["data"]["sessions_ended"] == 2, r.text
                ended, kept = [browser, phone_app], []
            else:  # pressed in this browser: the phone app's sign-in ends, this browser stays
                r = await c.post("/api/v2/auth/logout-others", json={"refresh_token": browser}, headers=_person(OWNER))
                assert r.status_code == 200 and r.json()["data"] == {"sessions_ended": 1, "kept_this": True}, r.text
                ended, kept = [phone_app], [browser]

            for rt in ended:
                assert (await c.post("/api/v2/auth/refresh", json={"refresh_token": rt})).status_code == 401, "that sign-in is over"
            for rt in kept:
                assert (await c.post("/api/v2/auth/refresh", json={"refresh_token": rt})).status_code == 200, "this browser stays"
            # the desktop agent: its own key
            agent = await c.get("/api/v2/agent-run-profile", headers={"Authorization": f"Bearer {agent_key}", "X-Org-Id": str(ORG)})
            assert agent.status_code == 200, agent.text
            # the daemon's device line: the setup's device token
            line = await c.put("/api/v2/desktop/relay/pairings", json={"pairings": [{"phone_key_fingerprint": _fp(der), "paired_at": datetime.now(timezone.utc).isoformat()}]},
                               headers=_tok(device["device_token"]))
            assert line.status_code == 200, line.text
            # the person's own API key
            listed = await c.get(PHONES, headers={"Authorization": f"Bearer {person_key}", "X-Org-Id": str(ORG)})
            assert listed.status_code == 200, listed.text
            # the phone key and its pair stay
            assert (await _sql(fetch=f"SELECT revoked_at IS NULL FROM remote_devices WHERE id = '{phone_id}'"))[0][0]
            assert (await _sql(fetch=f"SELECT count(*) FROM remote_device_pairings WHERE remote_device_id = '{phone_id}' AND removed_at IS NULL"))[0][0] == 1
    finally:
        await _sql(f"DELETE FROM human_api_keys WHERE member_id = '{OWNER_TM}'")


async def test_a_removed_member_cannot_fork_a_session_from_a_token_rotated_a_moment_ago(world):
    """story #4630 (PO 09:50Z) — the admin removal (`_revoke_user_refresh_tokens`) revoked live rows only: the token a rotation
    had just revoked kept its grace window (§2449 · expires_at untouched), and the removed person could fork a new session
    from it. Now the same seam as a reset closes it — 401. RED on develop (that refresh was 200)."""
    from tests.test_4424_desktop_setup_realdb import PLAIN

    async with _client() as c:
        old = await _login(PLAIN)
        rotated = await c.post("/api/v2/auth/refresh", json={"refresh_token": old})
        assert rotated.status_code == 200, rotated.text
        now_held = rotated.json()["data"]["refresh_token"]
        member_id = (await _sql(fetch=f"SELECT id FROM org_members WHERE org_id = '{ORG}' AND user_id = '{PLAIN}'"))[0][0]

        removed = await c.delete(f"/api/v2/org-members/{member_id}", headers=_person(OWNER))
        assert removed.status_code == 200, removed.text

        assert (await c.post("/api/v2/auth/refresh", json={"refresh_token": now_held})).status_code == 401
        assert (await c.post("/api/v2/auth/refresh", json={"refresh_token": old})).status_code == 401, "no fork from the grace window"
