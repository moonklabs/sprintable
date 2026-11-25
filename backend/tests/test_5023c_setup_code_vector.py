"""story 5023 (c) — the setup code the first sign-up on a workspace server needs is derived in TWO places: here (`services/server_owner_setup.setup_code`) and in the server host program that prints it
(`desktop-electron/src/server-setup-code.ts`, shown by `sprintable-host server status`). They only agree while both derive the same text, so the same two vectors are asserted on both ends
(the host's test: `test/server-setup-code-5023c.test.ts`). Change one and the other test goes red until it follows."""
from __future__ import annotations

import re

import pytest

from app.core.config import settings
from app.services import server_owner_setup

# (secret, code) — also in the host's test; a code is 16 base32 letters in four groups
VECTORS = [
    ("0123456789abcdef0123456789abcdef", "6OPB-TG4T-AAUB-67AE"),
    ("sprintable-5023-test-secret-aaaaaaaaaaaaaaaa", "XZF5-YRTQ-XSWZ-YGCN"),
]


@pytest.mark.parametrize("secret,code", VECTORS)
def test_the_code_of_a_secret_is_the_one_the_server_host_prints(monkeypatch, secret, code):
    monkeypatch.setattr(settings, "local_bootstrap_secret", secret)
    assert server_owner_setup.setup_code() == code
    assert re.fullmatch(r"[A-Z2-7]{4}(-[A-Z2-7]{4}){3}", code)


def test_a_typed_code_matches_in_any_case_with_spaces_or_no_dashes(monkeypatch):
    monkeypatch.setattr(settings, "local_bootstrap_secret", VECTORS[0][0])
    for typed in ("6OPB-TG4T-AAUB-67AE", "6opb tg4t aaub 67ae", "6OPBTG4TAAUB67AE", "  6opb-tg4t-aaub-67ae "):
        assert server_owner_setup.code_matches(typed) is True
    for typed in ("", None, "6OPB-TG4T-AAUB-67AF", "XZF5-YRTQ-XSWZ-YGCN"):
        assert server_owner_setup.code_matches(typed) is False
