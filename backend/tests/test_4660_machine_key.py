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


A, B, C = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()


def _line(machine_key, revoked_at=None, carried=()):
    """`carried` = the agents the line carried before the exchange under test (what `before` is built from)."""
    return SimpleNamespace(id=uuid.uuid4(), machine_key=machine_key, revoked_at=revoked_at, revoked_reason=None, carried=frozenset(carried))


def _retire(db, others, *, new, key="K", now=None):
    return asyncio.run(ds._retire_same_machine(
        db, machine_key=key, others=others, now=now or datetime(2026, 10, 12, tzinfo=timezone.utc),
        new_agents=frozenset(new), before={o.id: o.carried for o in others},
    ))


def test_retire_closes_only_the_same_key_lines_with_the_reason():
    now = datetime(2026, 10, 12, tzinfo=timezone.utc)
    same_old = _line("K", carried={A})
    other_machine = _line("OTHER", carried={A})
    already_closed = _line("K", revoked_at=datetime(2026, 10, 1, tzinfo=timezone.utc), carried={A})
    db = _FakeDb()

    count = _retire(db, [same_old, other_machine, already_closed], new={A}, now=now)

    assert count == 1
    assert same_old.revoked_at == now
    assert same_old.revoked_reason == "replaced_by_new_setup"
    assert other_machine.revoked_at is None and other_machine.revoked_reason is None
    assert already_closed.revoked_reason is None  # an earlier close is left as it was
    assert len(db.statements) == 2  # the device tokens of the closed line (one statement) and its clock view (story #4733: one delete — the row is already locked by the exchange)


def test_retire_with_no_match_touches_nothing():
    db = _FakeDb()
    assert _retire(db, [_line("OTHER", carried={A})], new={A}) == 0
    assert db.statements == []


def test_a_line_of_another_lane_on_the_same_machine_stays_open():
    # PO 10-15: one computer holds one setup per lane — a new setup with OTHER agents closes nothing
    lane_a = _line("K", carried={A})
    db = _FakeDb()
    assert _retire(db, [lane_a], new={B}) == 0
    assert lane_a.revoked_at is None and lane_a.revoked_reason is None
    assert db.statements == []


def test_a_line_is_closed_when_the_new_setup_has_all_its_agents_and_also_when_it_has_more():
    same, fewer = _line("K", carried={A, B}), _line("K", carried={A})
    db = _FakeDb()
    assert _retire(db, [same, fewer], new={A, B}) == 2
    assert same.revoked_reason == fewer.revoked_reason == "replaced_by_new_setup"


def test_a_line_that_still_carries_an_agent_the_new_setup_lacks_stays_open():
    # the new setup takes A only; the old line also carried B (A is moved out of it — B keeps it alive)
    old = _line("K", carried={A, B})
    db = _FakeDb()
    assert _retire(db, [old], new={A}) == 0
    assert old.revoked_at is None


def test_a_line_with_no_agent_left_is_closed_by_any_setup_on_the_machine():
    # PO 10-15 ③: its agents all moved elsewhere → nothing is left to cover → the next setup on the machine closes it
    empty = _line("K", carried=())
    db = _FakeDb()
    assert _retire(db, [empty], new={C}) == 1
    assert empty.revoked_reason == "replaced_by_new_setup"


def test_the_judgement_reads_the_before_argument_not_the_lines_current_members():
    # The exchange hands in what each line carried when it began (`before`); the function judges on that and never reads the
    # line's `members` itself. (Today the two agree for every reachable state — _rotate_existing_agent takes exactly the new
    # setup's agents out of the other lines — so this pins the contract of the function, not a separate scenario.)
    line = SimpleNamespace(id=uuid.uuid4(), machine_key="K", revoked_at=None, revoked_reason=None, members=[])
    now = datetime(2026, 10, 12, tzinfo=timezone.utc)
    carried_more = asyncio.run(ds._retire_same_machine(
        _FakeDb(), machine_key="K", others=[line], now=now, new_agents=frozenset({A}), before={line.id: frozenset({A, B})},
    ))
    assert carried_more == 0 and line.revoked_at is None
    carried_only_covered = asyncio.run(ds._retire_same_machine(
        _FakeDb(), machine_key="K", others=[line], now=now, new_agents=frozenset({A}), before={line.id: frozenset({A})},
    ))
    assert carried_only_covered == 1 and line.revoked_reason == "replaced_by_new_setup"


def test_agents_of_counts_agent_entries_of_any_kind_of_setup_and_ignores_people():
    line = SimpleNamespace(members=[
        {"kind": "agent", "member_id": str(A), "stage": "writer"}, {"kind": "agent", "member_id": str(A), "stage": "reviewer"},
        {"kind": "human", "member_id": str(B)}, {"kind": "agent", "member_id": str(C), "existing": True},
    ])
    assert ds._agents_of(line) == frozenset({A, C})
    assert ds._agents_of(SimpleNamespace(members=None)) == frozenset()


def test_exchange_body_without_device_id_still_parses_and_unknown_fields_are_ignored():
    # 까디르 주의 · PO: an app from before sends no device_id, and extra fields are ignored (no extra=forbid on this body)
    from app.routers.desktop_setup import ExchangeRequest

    verifier = "v" * 43
    old_app = ExchangeRequest(code="c" * 43, verifier=verifier)
    assert old_app.device_id is None
    with_extra = ExchangeRequest(code="c" * 43, verifier=verifier, something_new="x")
    assert with_extra.device_id is None
