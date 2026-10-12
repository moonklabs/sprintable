"""story 4660 (design 4660 · 까디르 렌즈 칸) — a new setup on the same machine closes the old «연결된 기기» lines.

The key and the retire step are checked here without a database: the key rules (fail-safe with no secret, org scope,
valid id only) and the retire step against plain objects. The end-to-end exchange runs on the real database elsewhere.
"""
import asyncio
import hashlib
import hmac
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.core.config import settings
from app.services import desktop_setup as ds

GOOD_DEVICE_ID = "a" * 64
SECRET = "test-desktop-machine-key-secret-value"


@pytest.fixture
def secret(monkeypatch):
    monkeypatch.setattr(settings, "channel_oauth_state_secret", SECRET)
    return SECRET


def test_no_secret_means_no_key_and_no_hmac_call(monkeypatch):
    # PO 결정 ① · 까디르 ③: with no secret the key is not made — and HMAC is never called with an empty key
    monkeypatch.setattr(settings, "channel_oauth_state_secret", "")

    def boom(*args, **kwargs):
        raise AssertionError("HMAC must not run without a secret")

    monkeypatch.setattr(hmac, "new", boom)
    assert ds.machine_key_for(uuid.uuid4(), GOOD_DEVICE_ID) is None


def test_missing_or_malformed_device_id_means_no_key(secret):
    org = uuid.uuid4()
    assert ds.machine_key_for(org, None) is None
    assert ds.machine_key_for(org, "") is None
    assert ds.machine_key_for(org, "not-hex") is None
    assert ds.machine_key_for(org, "A" * 64) is None  # uppercase is not the app's form
    assert ds.machine_key_for(org, "a" * 63) is None


def test_key_is_hmac_of_org_and_device_and_never_the_device_id(secret):
    org = uuid.UUID("11111111-1111-1111-1111-111111111111")
    key = ds.machine_key_for(org, GOOD_DEVICE_ID)
    derived = ds._hkdf_sha256(SECRET.encode(), info=ds.MACHINE_KEY_INFO)
    expected = hmac.new(derived, f"{org}|{GOOD_DEVICE_ID}".encode(), hashlib.sha256).hexdigest()
    assert key == expected
    assert key != GOOD_DEVICE_ID


def test_same_machine_in_two_orgs_gets_two_keys(secret):
    # 까디르 ② — org scope: the same machine id under another org never matches this org's line
    a = ds.machine_key_for(uuid.uuid4(), GOOD_DEVICE_ID)
    b = ds.machine_key_for(uuid.uuid4(), GOOD_DEVICE_ID)
    assert a != b


def test_changing_the_info_label_changes_the_key(secret, monkeypatch):
    org = uuid.uuid4()
    before = ds.machine_key_for(org, GOOD_DEVICE_ID)
    monkeypatch.setattr(ds, "MACHINE_KEY_INFO", b"sprintable/desktop-machine-key/v2")
    assert ds.machine_key_for(org, GOOD_DEVICE_ID) != before


def test_same_machine_same_org_gets_the_same_key(secret):
    org = uuid.uuid4()
    assert ds.machine_key_for(org, GOOD_DEVICE_ID) == ds.machine_key_for(org, GOOD_DEVICE_ID)


class _FakeDb:
    def __init__(self):
        self.statements = []

    async def execute(self, stmt):
        self.statements.append(stmt)


def _line(machine_key, revoked_at=None):
    return SimpleNamespace(id=uuid.uuid4(), machine_key=machine_key, revoked_at=revoked_at, revoked_reason=None)


def test_retire_closes_only_the_same_key_lines_with_the_reason():
    now = datetime(2026, 10, 12, tzinfo=timezone.utc)
    same_old = _line("K")
    other_machine = _line("OTHER")
    already_closed = _line("K", revoked_at=datetime(2026, 10, 1, tzinfo=timezone.utc))
    db = _FakeDb()

    count = asyncio.run(ds._retire_same_machine(db, machine_key="K", others=[same_old, other_machine, already_closed], now=now))

    assert count == 1
    assert same_old.revoked_at == now
    assert same_old.revoked_reason == "replaced_by_new_setup"
    assert other_machine.revoked_at is None and other_machine.revoked_reason is None
    assert already_closed.revoked_reason is None  # an earlier close is left as it was
    assert len(db.statements) == 1  # one statement revokes the device tokens of the closed line


def test_retire_with_no_match_touches_nothing():
    db = _FakeDb()
    count = asyncio.run(ds._retire_same_machine(db, machine_key="K", others=[_line("OTHER")], now=datetime.now(timezone.utc)))
    assert count == 0
    assert db.statements == []


def test_exchange_body_without_device_id_still_parses_and_unknown_fields_are_ignored():
    # 까디르 주의 · PO: an app from before sends no device_id, and extra fields are ignored (no extra=forbid on this body)
    from app.routers.desktop_setup import ExchangeRequest

    verifier = "v" * 43
    old_app = ExchangeRequest(code="c" * 43, verifier=verifier)
    assert old_app.device_id is None
    with_extra = ExchangeRequest(code="c" * 43, verifier=verifier, something_new="x")
    assert with_extra.device_id is None
