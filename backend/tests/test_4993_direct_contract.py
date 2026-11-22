"""story 4993 (P2 · same-network direct) — the negotiation contract the server shares with the mobile repository (`contracts/direct-negotiation.json`: the canonical texts of a phone's sealed ask and a computer's sealed answer, the constants
both sides use, the closed refusal words). The server never opens either text; what it holds to the contract is the CONSTANTS it judges by (the header word, the size classes, the answer's lifetime, the command word, the route) and the one
fact that makes the two repositories one contract: the file is the same bytes (its hash is pinned here, and the mobile repository's test pins the same file by its content). Each check goes red without the line it names.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from app.models.desktop_relay import COMMAND_KINDS
from app.services import desktop_direct
from app.services.envelope_shape import ENVELOPE_KINDS, MAX_CT_BYTES_BY_KIND

_FILE = Path(__file__).resolve().parents[2] / "contracts" / "direct-negotiation.json"
# the sha256 of the file's bytes as the mobile repository committed it (mobile `contracts/direct-negotiation.json`, main d0e291bf) — a copy that drifts is RED, and so is a change of the file that did not change this line with it
_SHA256 = "907a513c4d5438776087accea8f2c12465428d052a9e3a028c4aa8bfe878623a"


def _contract() -> dict:
    return json.loads(_FILE.read_text(encoding="utf-8"))


def test_the_copy_is_the_same_bytes_as_the_mobile_repositorys_file() -> None:
    assert hashlib.sha256(_FILE.read_bytes()).hexdigest() == _SHA256, "contracts/direct-negotiation.json is not the mobile repository's file (copy it again, byte for byte, and change this hash with it)"


def test_the_constants_the_server_judges_by_are_the_contracts() -> None:
    k = _contract()["constants"]
    assert k["session_key"] == desktop_direct.DIRECT_SESSION_KEY == "direct"
    assert k["command_kind"] == desktop_direct.ASK_KIND and desktop_direct.ASK_KIND in COMMAND_KINDS
    assert desktop_direct.ANSWER_KIND in ENVELOPE_KINDS and desktop_direct.ASK_KIND in ENVELOPE_KINDS
    assert k["offer_ttl_ms"] == int(desktop_direct.DIRECT_TTL.total_seconds() * 1000), "the answer waits as long as the contract says it may be read"
    assert MAX_CT_BYTES_BY_KIND["direct_open"] == k["open_ct_max"], "the size class of an ask is the contract's"
    assert MAX_CT_BYTES_BY_KIND["direct_offer"] >= 2 * k["offer_bucket"], "an answer is padded to whole buckets: the server takes at least two"
    assert k["frame_version"] == 1


def test_the_route_the_computer_puts_its_answer_to_is_the_contracts_and_exists() -> None:
    from app.main import app

    path = _contract()["constants"]["put_path"].replace("<command_id>", "{command_id}")
    assert any(getattr(r, "path", None) == path and "PUT" in getattr(r, "methods", ()) for r in app.routes), path


def test_the_refusal_words_are_closed_words_of_the_computer_never_a_server_word() -> None:
    words = _contract()["refusal_codes"]
    assert len(words) == len(set(words)) and all(w.startswith("DIR_") and w.isupper() for w in words), words
    # (the server forwards the answer unread: none of these is a code of its own — a server code never starts with DIR_)
    from app.services.desktop_relay import DesktopRelayError  # noqa: F401  (the server's errors are lower-case words)
    assert not any(w.lower() in {"direct_busy", "direct_too_fast"} for w in words)


def test_the_ask_text_in_the_contract_is_what_the_server_would_take_as_an_envelope_plaintext_size() -> None:
    c = _contract()
    # the canonical ask is a short text: inside the 256-byte padded frame the phone seals it into (and far inside the ask's size class)
    assert len(c["open_text"].encode()) + 4 <= 256 <= c["constants"]["open_ct_max"]
    assert len(c["offer_text"].encode()) + 4 <= 2 * c["constants"]["offer_bucket"]
