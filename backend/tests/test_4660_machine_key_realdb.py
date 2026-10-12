"""story 4660 (design 4660 · PO 결정 · 까디르 렌즈) — a new setup on the same machine closes the old «연결된 기기» lines.

Real database. The app sends `device_id` (its salted hash of the machine id) with the exchange; the server keeps an org-scoped
HMAC of it and, for the same org and key, closes the older lines with the reason «새 셋업으로 대체» and revokes their device
tokens (the old token is then refused by the relay). The agents and their keys stay.
"""
from __future__ import annotations

import pytest

from app.core.config import settings
from app.services.desktop_setup import machine_key_for
from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    OWNER,
    _client,
    _code,
    _confirm,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)

pytestmark = pytest.mark.anyio

SECRET = "test-desktop-machine-key-secret-value-4660"
SAME_MACHINE = "b" * 64
OTHER_MACHINE = "c" * 64


@pytest.fixture(autouse=True)
async def _remote_control_on(world):
    """story #4535 — the relay refuses an org whose «원격 제어» is off; these tests are about an org that turned it on."""
    await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG}'")
    yield


@pytest.fixture
def secret(monkeypatch):
    monkeypatch.setattr(settings, "desktop_machine_key_secret", SECRET)
    return SECRET


async def _device(c, name: str, device_id: str | None) -> dict:
    """A device set up on this org: code, confirm, exchange — with the device_id when given."""

    code, verifier = await _code(c, name)
    assert (await _confirm(c, code)).status_code == 200
    body = {"code": code, "verifier": verifier, **({"device_id": device_id} if device_id else {})}
    r = await c.post("/api/v2/desktop/setup-codes/exchange", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _tok(token: str) -> dict:
    return {"x-desktop-device-token": token}


async def _line(setup_id: str) -> tuple:
    rows = await _sql(fetch=f"SELECT revoked_at IS NOT NULL, revoked_reason, machine_key FROM desktop_setups WHERE id = '{setup_id}'")
    return tuple(rows[0])


async def test_the_same_machine_twice_closes_the_old_line_and_its_old_token_is_refused(world, secret):
    async with _client() as c:
        first = await _device(c, "d4660 mac first", SAME_MACHINE)
        # the old line is heard from once, so it has a «last heard» time to show
        assert (await c.put("/api/v2/desktop/relay/sessions", json={"report_seq": 1, "sessions": []}, headers=_tok(first["device_token"]))).status_code == 200

        second = await _device(c, "d4660 mac second", SAME_MACHINE)

        closed, reason, first_key = await _line(first["setup_id"])
        assert closed is True and reason == "새 셋업으로 대체"
        assert first_key == machine_key_for(ORG, SAME_MACHINE)
        open_now, _, second_key = await _line(second["setup_id"])
        assert open_now is False and second_key == first_key

        old = await c.put("/api/v2/desktop/relay/sessions", json={"report_seq": 2, "sessions": []}, headers=_tok(first["device_token"]))
        assert old.status_code == 401, old.text
        assert old.json()["detail"]["code"] == "DEVICE_TOKEN_INVALID"
        new = await c.put("/api/v2/desktop/relay/sessions", json={"report_seq": 1, "sessions": []}, headers=_tok(second["device_token"]))
        assert new.status_code == 200, new.text

        # the old line's agents and their keys are not stopped by the replacement (only its device token is revoked)
        live_keys = (await _sql(fetch=f"SELECT count(*) FROM agent_api_keys k WHERE k.desktop_setup_id = '{first['setup_id']}' AND k.revoked_at IS NULL"))[0][0]
        assert live_keys == len(first["agents"])


async def test_a_different_machine_in_the_same_org_leaves_the_line_open(world, secret):
    async with _client() as c:
        first = await _device(c, "d4660 mac a", SAME_MACHINE)
        await _device(c, "d4660 mac b", OTHER_MACHINE)
        closed, reason, _ = await _line(first["setup_id"])
        assert closed is False and reason is None


async def test_no_secret_means_no_key_and_no_line_is_closed(world, monkeypatch):
    # PO ①·까디르 ③: the secret is empty → no key is made, nothing is closed, the new line is added as before
    monkeypatch.setattr(settings, "desktop_machine_key_secret", "")
    async with _client() as c:
        first = await _device(c, "d4660 no-secret a", SAME_MACHINE)
        second = await _device(c, "d4660 no-secret b", SAME_MACHINE)
        closed, reason, first_key = await _line(first["setup_id"])
        assert closed is False and reason is None and first_key is None
        _, _, second_key = await _line(second["setup_id"])
        assert second_key is None


async def test_an_app_that_sends_no_device_id_gets_the_old_behaviour(world, secret):
    # AC2 / PO: an older app sends no device_id → no key, no close — the same as before this story
    async with _client() as c:
        first = await _device(c, "d4660 old-app a", None)
        second = await _device(c, "d4660 old-app b", None)
        closed, reason, first_key = await _line(first["setup_id"])
        assert closed is False and reason is None and first_key is None
        _, _, second_key = await _line(second["setup_id"])
        assert second_key is None


async def test_the_list_reports_the_replaced_reason_and_the_last_heard_time(world, secret):
    async with _client() as c:
        first = await _device(c, "d4660 list first", SAME_MACHINE)
        assert (await c.put("/api/v2/desktop/relay/sessions", json={"report_seq": 1, "sessions": []}, headers=_tok(first["device_token"]))).status_code == 200
        await _device(c, "d4660 list second", SAME_MACHINE)

        r = await c.get("/api/v2/desktop/setups", headers=_person(OWNER, ORG))
        assert r.status_code == 200, r.text
        item = next(s for s in r.json()["setups"] if s["setup_id"] == first["setup_id"])
        assert item["state"] == "disconnected"
        assert item["revoked_reason"] == "새 셋업으로 대체"
        assert item["last_used_at"] is not None
