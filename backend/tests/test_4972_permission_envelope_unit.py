"""story 4972 — the server's check of an envelope it cannot open: shape and size only (design ① D5)."""
from __future__ import annotations

import base64

import pytest

from app.services.envelope_shape import check_envelope


def b64(n: int) -> str:
    return base64.urlsafe_b64encode(b"\x07" * n).rstrip(b"=").decode()


def good(**over):
    env = {
        "v": 1, "kind": "approval_card", "setup_id": "s", "session_key": "s-1", "command_id": "c", "expires_at": 1_790_000_000_000, "from": "host-1",
        "to": ["p1", "p2"], "epoch": 1, "ctr": 0, "ts": 1_790_000_000_000, "nonce": b64(16),
        "wraps": [{"to": "p1", "enc": b64(32), "ek": b64(48)}, {"to": "p2", "enc": b64(32), "ek": b64(48)}], "ct": b64(100), "sig": b64(71),
    }
    env.update(over)
    return env


def test_a_well_shaped_envelope_comes_back_unchanged():
    env = good()
    assert check_envelope(env, kind="approval_card") is env
    assert check_envelope(good(rec={"conversation_id": "c", "record_id": "r", "rec_gen": 1}))["rec"]["rec_gen"] == 1


@pytest.mark.parametrize("mut", [
    {"v": 2}, {"v": True}, {"kind": "nope"}, {"kind": "chat_line"},  # not the kind this place takes
    {"extra": 1}, {"to": []}, {"to": ["p1", "p1"]}, {"to": ["p%d" % i for i in range(17)]}, {"to": ["p1", 5]},
    {"nonce": b64(15)}, {"nonce": "AA=="}, {"nonce": "AB"}, {"ct": b64(10)}, {"ct": "!!!!"}, {"sig": b64(3)}, {"sig": b64(200)},
    {"epoch": -1}, {"ctr": 1.5}, {"ts": True}, {"expires_at": 2**53}, {"from": "x" * 300}, {"setup_id": 5},
    {"wraps": [{"to": "p1", "enc": b64(32), "ek": b64(48)}]},  # one wrap for two receivers
    {"wraps": [{"to": "p2", "enc": b64(32), "ek": b64(48)}, {"to": "p1", "enc": b64(32), "ek": b64(48)}]},  # not in the receivers' order
    {"wraps": [{"to": "p1", "enc": b64(31), "ek": b64(48)}, {"to": "p2", "enc": b64(32), "ek": b64(48)}]},
    {"wraps": [{"to": "p1", "enc": b64(32), "ek": b64(47)}, {"to": "p2", "enc": b64(32), "ek": b64(48)}]},
    {"wraps": [{"to": "p1", "enc": b64(32), "ek": b64(48), "x": 1}, {"to": "p2", "enc": b64(32), "ek": b64(48)}]},
    {"rec": {"conversation_id": "c"}}, {"rec": "x"},
])
def test_a_badly_shaped_envelope_is_refused(mut):
    with pytest.raises(ValueError):
        check_envelope(good(**mut), kind="approval_card")


def test_a_missing_field_and_a_non_object_are_refused():
    env = good()
    del env["sig"]
    for bad in (env, [], "x", None):
        with pytest.raises(ValueError):
            check_envelope(bad)


def test_the_body_size_limit():
    check_envelope(good(ct=b64(256 * 1024 + 16)))
    with pytest.raises(ValueError):
        check_envelope(good(ct=b64(256 * 1024 + 17)))
