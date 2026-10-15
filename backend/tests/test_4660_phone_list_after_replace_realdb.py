"""story 4660 (PO 2026-10-13) — after a new setup replaces the same machine's old line, the person's phone list shows that machine
once: the new setup. The old line's pairing is not listed because its setup is revoked (`list_phones` filters that).

Real database. The phone and the pairing helpers are copied from test_4533 (importing that module would collect its tests again).
"""
from __future__ import annotations

import base64
import hashlib

import pytest

from app.core.config import settings
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

SECRET = "test-desktop-machine-key-secret-value-4660-phone"
SAME_MACHINE = "9" * 64
PHONES = "/api/v2/remote-devices"
EXCHANGE = "/api/v2/desktop/setup-codes/exchange"


@pytest.fixture(autouse=True)
def _addresses(monkeypatch):
    """The exchange hands over the API and MCP addresses; a deployment sets them, a test sets its own (as in 4660)."""
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://mcp.d4660p.test/mcp")
    monkeypatch.setenv("FASTAPI_URL", "https://api.d4660p.test")


@pytest.fixture(autouse=True)
async def _remote_control_on(world):
    await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG}'")
    yield


@pytest.fixture
def secret(monkeypatch):
    monkeypatch.setattr(settings, "channel_oauth_state_secret", SECRET)
    return SECRET


def _tok(token: str) -> dict:
    return {"x-desktop-device-token": token}


def _phone_key() -> tuple[str, bytes]:
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    der = ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
    return base64.urlsafe_b64encode(der).rstrip(b"=").decode(), der


def _fp(der: bytes) -> str:
    return "sha256:" + hashlib.sha256(der).hexdigest()


async def _device(c, name: str, device_id: str) -> dict:
    code, verifier = await _code(c, name)
    assert (await _confirm(c, code)).status_code == 200
    r = await c.post(EXCHANGE, json={"code": code, "verifier": verifier, "device_id": device_id})
    assert r.status_code == 200, r.text
    return r.json()


async def _register(c) -> tuple[str, bytes]:
    key, der = _phone_key()
    r = await c.post(PHONES, json={"label": "iPhone", "public_key": key}, headers=_person(OWNER))
    assert r.status_code == 201, r.text
    return r.json()["id"], der


async def _pair(c, token: str, der: bytes) -> None:
    from datetime import datetime, timezone

    at = datetime.now(timezone.utc).isoformat()
    r = await c.put("/api/v2/desktop/relay/pairings", json={"pairings": [{"phone_key_fingerprint": _fp(der), "paired_at": at}]},
                    headers=_tok(token))
    assert r.status_code == 200, r.text


async def test_after_a_replacement_the_phone_list_shows_the_machine_once(world, secret):
    async with _client() as c:
        old = await _device(c, "d4660p old mac", SAME_MACHINE)
        phone, der = await _register(c)
        await _pair(c, old["device_token"], der)

        new = await _device(c, "d4660p new mac", SAME_MACHINE)
        await _pair(c, new["device_token"], der)

        r = await c.get(PHONES, headers=_person(OWNER))
        assert r.status_code == 200, r.text
        mine = next(d for d in r.json()["devices"] if d["id"] == phone)
        assert [p["setup_id"] for p in mine["pairs"]] == [new["setup_id"]]
