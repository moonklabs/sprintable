"""story 4977 B2 — the server's check of a RECORD envelope it cannot open (design ② §4-1b): shape and size only; no receivers, a `rec` always, no field name of the caller's ever echoed."""
from __future__ import annotations

import base64
import json
import uuid

import pytest

from app.services import session_records
from app.services.desktop_relay import DesktopRelayError
from app.services.envelope_shape import MAX_RECORD_CT_BYTES, check_envelope, check_record_envelope

CONV = str(uuid.UUID("0b98dae4-5e9c-4c11-9a2d-1f6e3d7a8b90"))


def b64(n: int) -> str:
    return base64.urlsafe_b64encode(b"\x07" * n).rstrip(b"=").decode()


def good(**over):
    env = {
        "v": 1, "kind": "chat_line", "setup_id": "s", "session_key": "", "command_id": "", "expires_at": 0, "from": "phone-key-1", "to": [], "epoch": 3, "ctr": 7, "ts": 1_790_000_000_007,
        "nonce": b64(16), "wraps": [], "ct": b64(68), "sig": b64(71), "rec": {"conversation_id": CONV, "record_id": "rec-0001", "rec_gen": 1},
    }
    env.update(over)
    return env


def test_a_well_shaped_record_comes_back_unchanged_for_both_kinds():
    for kind in ("chat_line", "approval_record"):
        env = good(kind=kind)
        assert check_record_envelope(env) is env


@pytest.mark.parametrize(
    "over",
    [
        {"to": ["p1"], "wraps": [{"to": "p1", "enc": b64(32), "ek": b64(48)}]},  # a transport shape: a record has no receivers
        {"to": ["p1"]}, {"wraps": [{"to": "p1", "enc": b64(32), "ek": b64(48)}]},
        {"kind": "send_prompt"}, {"kind": "approval_card"}, {"kind": "record_handoff"}, {"kind": "nope"}, {"kind": 7},
        {"v": 2}, {"v": True}, {"from": ""}, {"from": "x" * 257}, {"from": "a\x00b"}, {"setup_id": 5},
        {"nonce": b64(15)}, {"nonce": b64(17)}, {"nonce": "!!"}, {"ct": b64(19)}, {"ct": b64(MAX_RECORD_CT_BYTES + 17)}, {"ct": "a" * 10}, {"sig": b64(7)}, {"sig": b64(81)},
        {"epoch": -1}, {"ctr": 2**53}, {"ts": 1.5}, {"expires_at": True},
        {"rec": None}, {"rec": {}}, {"rec": {"conversation_id": CONV, "record_id": "r"}}, {"rec": {"conversation_id": CONV, "record_id": "r", "rec_gen": 1, "x": 1}},
        {"rec": {"conversation_id": "not-a-uuid", "record_id": "r", "rec_gen": 1}},
        {"rec": {"conversation_id": CONV.upper(), "record_id": "r", "rec_gen": 1}},  # one spelling of a conversation id
        {"rec": {"conversation_id": CONV, "record_id": "", "rec_gen": 1}}, {"rec": {"conversation_id": CONV, "record_id": "r", "rec_gen": 0}},
        {"rec": {"conversation_id": CONV, "record_id": "r", "rec_gen": 2**31}}, {"rec": {"conversation_id": CONV, "record_id": "r", "rec_gen": 2**53 - 1}},  # past the column
        {"rec": {"conversation_id": CONV, "record_id": "r", "rec_gen": -1}}, {"rec": {"conversation_id": CONV, "record_id": "r", "rec_gen": True}},
        {"rec": {"conversation_id": CONV, "record_id": "r\n", "rec_gen": 1}},
    ],
)
def test_a_record_that_is_not_the_agreed_shape_is_refused(over):
    with pytest.raises(ValueError):
        check_record_envelope(good(**over))


def test_unknown_and_missing_header_fields_are_refused_and_rec_is_not_optional():
    env = good()
    with pytest.raises(ValueError):
        check_record_envelope({**env, "extra": 1})
    for k in list(env):
        short = {x: y for x, y in env.items() if x != k}
        with pytest.raises(ValueError):
            check_record_envelope(short)
    with pytest.raises(ValueError):
        check_record_envelope("not an object")
    with pytest.raises(ValueError):
        check_record_envelope({1: 2})


def test_a_refusal_never_echoes_a_field_name_or_a_value_of_the_caller():
    secret = "MK4977-secret-field"
    for bad in ({**good(), secret: 1}, good(**{"from": secret + "\x00"}), good(rec={"conversation_id": secret, "record_id": "r", "rec_gen": 1}), good(kind=secret)):
        with pytest.raises(ValueError) as e:
            check_record_envelope(bad)
        assert secret not in str(e.value)


def test_the_transport_check_still_takes_a_transport_shape_and_the_record_check_takes_only_a_record():
    transport = good(to=["p1"], wraps=[{"to": "p1", "enc": b64(32), "ek": b64(48)}])
    assert check_envelope(transport)["kind"] == "chat_line"  # the old check is as it was (a later story retires the record kinds there)
    with pytest.raises(ValueError):
        check_record_envelope(transport)


def test_the_body_parse_never_puts_the_input_into_an_error():
    secret = "MK4977-in-the-body"
    raw = json.dumps({"envelope": {**good(), secret: secret}, "phone_key_id": str(uuid.uuid4())}).encode()
    with pytest.raises(DesktopRelayError) as e:
        session_records.parse_phone_write(raw)
    assert e.value.status == 422 and e.value.code == "invalid_record" and secret not in e.value.message
    for raw in (b"not json", b"[]", json.dumps({"envelope": good()}).encode(), json.dumps({"envelope": good(), "phone_key_id": "x"}).encode(),
                json.dumps({"envelope": good(), "phone_key_id": str(uuid.uuid4()), "more": 1}).encode()):
        with pytest.raises(DesktopRelayError) as e:
            session_records.parse_phone_write(raw)
        assert e.value.status == 422
    ok = session_records.parse_phone_write(json.dumps({"envelope": good(), "phone_key_id": str(uuid.uuid4())}).encode())
    assert ok.envelope["rec"]["rec_gen"] == 1
    assert session_records.parse_host_write(json.dumps({"envelope": good()}).encode()).envelope["kind"] == "chat_line"
    with pytest.raises(DesktopRelayError) as e:
        session_records.parse_host_write(json.dumps({"envelope": good(), "phone_key_id": str(uuid.uuid4())}).encode())  # the computer's body has no phone
    assert e.value.status == 422


def test_a_body_over_the_limit_is_refused_before_it_is_parsed():
    with pytest.raises(DesktopRelayError) as e:
        session_records.parse_host_write(b"x" * (session_records.BODY_MAX + 1))
    assert e.value.status == 413


def test_the_largest_key_generation_the_column_holds_is_accepted():
    assert check_record_envelope(good(rec={"conversation_id": CONV, "record_id": "r", "rec_gen": 2**31 - 1}))["rec"]["rec_gen"] == 2**31 - 1
