"""story 4978 (C2) — what the server may judge of a `record_handoff` envelope it cannot open: the agreed envelope shape, then THIS kind's own — one receiver, no `rec`, no session key, a body of exactly ONE width (so its size tells nothing about how many key
generations travel) and the pairing the request is for. No database."""
from __future__ import annotations

import base64
import uuid

import pytest

from app.services.envelope_shape import HANDOFF_CT_BYTES, check_envelope, check_record_handoff

SID = str(uuid.uuid4())


def _b64(n: int) -> str:
    return base64.urlsafe_b64encode(b"\x09" * n).rstrip(b"=").decode()


def _env(**over) -> dict:
    env = {
        "v": 1, "kind": "record_handoff", "setup_id": SID, "session_key": "", "command_id": _b64(16), "expires_at": 2_000_000, "from": "host-1", "to": ["phone-1"],
        "epoch": 1, "ctr": 0, "ts": 1_000_000, "nonce": _b64(16), "wraps": [{"to": "phone-1", "enc": _b64(32), "ek": _b64(48)}], "ct": _b64(HANDOFF_CT_BYTES), "sig": _b64(71),
    }
    env.update(over)
    return env


def test_the_fixed_width_is_the_one_the_phone_and_the_computer_seal_to():
    assert HANDOFF_CT_BYTES == 14592 + 16  # the 14,592-byte frame + the 16-byte tag (lib/recordHandoff.js · desktop-host record-handoff.ts)


def test_an_envelope_of_the_agreed_shape_is_returned_unchanged():
    env = _env()
    assert check_record_handoff(env, setup_id=SID) is env


@pytest.mark.parametrize("n", [HANDOFF_CT_BYTES - 1, HANDOFF_CT_BYTES + 1, 4096, 20])
def test_a_body_of_any_other_width_is_refused(n):
    with pytest.raises(ValueError):
        check_record_handoff(_env(ct=_b64(n)), setup_id=SID)


def test_the_kind_must_be_a_record_handoff_and_the_pairing_must_be_the_one_asked_for():
    with pytest.raises(ValueError):
        check_record_handoff(_env(kind="send_prompt"), setup_id=SID)
    with pytest.raises(ValueError):
        check_record_handoff(_env(), setup_id=str(uuid.uuid4()))


def test_one_receiver_no_record_no_session_key():
    two = _env(to=["a", "b"], wraps=[{"to": "a", "enc": _b64(32), "ek": _b64(48)}, {"to": "b", "enc": _b64(32), "ek": _b64(48)}])
    for bad in (two, _env(rec={"conversation_id": "c", "record_id": "r", "rec_gen": 1}), _env(session_key="s-1")):
        with pytest.raises(ValueError):
            check_record_handoff(bad, setup_id=SID)


def test_the_general_checker_still_accepts_the_kind_only_up_to_its_own_cap():
    check_envelope(_env(), kind="record_handoff")
    with pytest.raises(ValueError):
        check_envelope(_env(ct=_b64(HANDOFF_CT_BYTES + 17)), kind="record_handoff")  # past the cap (+ the tag) even for the general checker


def test_no_word_of_the_callers_comes_back_in_the_message():
    mark = "ZQ9-SHAPE-LEAK-MARKER"
    for bad in ({**_env(), mark: 1}, _env(ct=mark), _env(setup_id=mark)):
        with pytest.raises(ValueError) as e:
            check_record_handoff(bad, setup_id=SID)
        assert mark not in str(e.value)


def test_the_body_reader_takes_nothing_past_its_own_cap_before_it_parses():
    from app.services import desktop_record_handoff as handoff
    from app.services.desktop_relay import DesktopRelayError

    with pytest.raises(DesktopRelayError) as e:
        handoff.parse_body(b" " * (handoff.BODY_MAX + 1), setup_id=uuid.UUID(SID))
    assert e.value.status == 413 and e.value.code == "record_handoff_too_large"
