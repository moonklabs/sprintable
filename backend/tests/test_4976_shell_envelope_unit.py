"""story 4976 A3 — what the PHONE SHELL makes is what the SERVER takes.

backend/tests/fixtures/4976_shell_sealed_prompt.json holds real sealed `send_prompt` envelopes made by the phone shell's own code (sprintable-mobile `lib/sendPromptEnvelope.js`, real P-256
signature, throwaway keys; made by `dump-env.js` at the mobile head named in the file): a short text, 400 emoji (the most bytes a 400-code-point instruction can take) and 400 quotes (the most
escapes). The words are sealed — none is in the file. This test holds the server's side of the contract on them: the request model (extra fields refused · the envelope's shape and sizes ·
no text and no plain signature beside it) and the header checks of `create_command` (this computer · this session · THIS press's own key · the time window · the lifetime).
"""
from __future__ import annotations

import json
import pathlib
import uuid

import pytest
from pydantic import ValidationError

from app.services.desktop_commands import ENVELOPE_LIFETIME_MAX_MS, ENVELOPE_TS_SKEW_MS, CommandRequest

FIX = json.loads((pathlib.Path(__file__).parent / "fixtures" / "4976_shell_sealed_prompt.json").read_text())


def request(env: dict, **over) -> CommandRequest:
    base = dict(kind="send_prompt", session_key=FIX["session"], conversation_id=uuid.UUID(FIX["conversation"]), idempotency_key=FIX["key"],
                phone_key_id=uuid.UUID(FIX["phone_key_id"]), envelope=env)
    base.update(over)
    return CommandRequest(**base)


def header_ok(env: dict, body: CommandRequest, now_ms: int) -> bool:
    """the same comparison create_command makes before it stores the envelope (desktop_commands.py: «the header the phone sealed must be about THIS press's»)"""
    return (env["setup_id"] == FIX["setup"] and env["session_key"] == body.session_key and env["command_id"] == body.idempotency_key
            and abs(env["ts"] - now_ms) <= ENVELOPE_TS_SKEW_MS and env["ts"] <= env["expires_at"] <= env["ts"] + ENVELOPE_LIFETIME_MAX_MS)


@pytest.mark.parametrize("i", range(3))
def test_what_the_shell_made_is_taken_by_the_request_model_and_the_header_checks(i):
    env = FIX["envs"][i]
    body = request(env)
    assert body.envelope == env and body.text is None and body.signed is None
    assert header_ok(env, body, FIX["now"]), FIX["texts"][i]
    assert header_ok(env, body, FIX["now"] + 5 * 60_000), "the shell's own five-minute window is inside the server's"


def test_the_press_key_is_what_binds_an_envelope_to_one_press():
    env = FIX["envs"][0]
    assert not header_ok(env, request(env, idempotency_key="another-press-key"), FIX["now"]), "a copy of an envelope under another press's key is refused"
    assert not header_ok(env, request(env), FIX["now"] + ENVELOPE_TS_SKEW_MS + 1), "a time far from the server's clock is refused"


def test_a_sealed_body_carries_nothing_beside_its_envelope():
    env = FIX["envs"][0]
    for extra in ({"text": "plain words"}, {"signed": "x.y"}):
        with pytest.raises(ValidationError):
            request(env, **extra)
    with pytest.raises(ValidationError):
        request(env, conversation_id=None)
    with pytest.raises(ValidationError):
        request(env, kind="stop_session")
    # what the server's shape check refuses of an envelope it cannot open: text that is not base64url · a body over the 8 KiB sealed-instruction cap · a nonce of another length · an unknown field
    big = "A" * (4 * (8 * 1024 + 16 + 64) // 3)
    for bad in ({**env, "ct": env["ct"] + "!"}, {**env, "ct": big}, {**env, "nonce": env["nonce"][:-4]}, {**env, "sig": "A"}, {**env, "extra": 1}, {**env, "kind": "approval_card"}):
        with pytest.raises(ValidationError):
            request(bad)
