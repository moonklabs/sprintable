"""story 5034 (C4 step 2) — the chat card field: `msg_metadata['card'] = {kind, ref}` written ONLY by the server, drawn by the web's catalogue.

Red when: the closed kind list drifts from the web's (apps/web/src/components/chat/cards/card-kinds.ts) · a card carries anything but its two words · a kind outside the list or a reference that is not a
UUID is accepted · the PUBLIC message route takes a `card` (it must be 422 — a client can never stamp a message with a card, same as `event_context`) · the in-process request does not carry it into
`msg_metadata` · a message's payload serves a card that does not fit the shape · a deleted message still serves its card.
"""
from __future__ import annotations

import re
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.routers.conversations import (
    HttpSendMessageRequest,
    SendMessageRequest,
    _card_payload,
    _combined_msg_metadata,
    _msg_payload,
)
from app.services.chat_card import CARD_KINDS, normalize_card

ID = "0d6e953f-6d43-42c1-a87c-b023544497db"
WEB_KINDS_FILE = Path(__file__).resolve().parents[2] / "apps/web/src/components/chat/cards/card-kinds.ts"


def test_the_kind_list_is_the_webs_list_word_for_word():
    if not WEB_KINDS_FILE.exists():
        pytest.skip("the web's card-kinds.ts is not in this tree yet (web step 1 is a separate PR) — this parity check runs once both are on develop")
    text = WEB_KINDS_FILE.read_text(encoding="utf-8")
    m = re.search(r"export const CARD_KINDS = \[([^\]]*)\] as const", text)
    assert m, "the web's CARD_KINDS declaration was not found — this parity test reads that file"
    web = tuple(re.findall(r"'([a-z_]+)'", m.group(1)))
    assert web == CARD_KINDS


class TestNormalizeCard:
    def test_a_known_kind_with_a_uuid_is_a_card(self):
        assert normalize_card({"kind": "story", "ref": ID}) == {"kind": "story", "ref": ID}

    def test_the_reference_is_stored_lower_case_in_the_plain_dashed_form(self):
        assert normalize_card({"kind": "doc", "ref": ID.upper()}) == {"kind": "doc", "ref": ID}

    @pytest.mark.parametrize("ref", [f"{{{ID}}}", f"urn:uuid:{ID}", ID.replace("-", ""), f"{ID}/../x", " " + ID, ""])
    def test_other_spellings_of_a_uuid_and_paths_are_not_cards(self, ref):
        assert normalize_card({"kind": "story", "ref": ref}) is None

    def test_only_the_two_words_survive(self):
        got = normalize_card({"kind": "story", "ref": ID, "html": "<img src=x onerror=alert(1)>", "title": "x", "url": "javascript:alert(1)"})
        assert got == {"kind": "story", "ref": ID}

    @pytest.mark.parametrize("raw", [None, "story", ["story", ID], 7, {}, {"kind": "story"}, {"ref": ID}, {"kind": "timeline", "ref": ID}, {"kind": 7, "ref": ID}, {"kind": "story", "ref": 7}])
    def test_anything_else_is_not_a_card(self, raw):
        assert normalize_card(raw) is None

    def test_every_kind_of_the_list_is_accepted(self):
        for k in CARD_KINDS:
            assert normalize_card({"kind": k, "ref": ID}) == {"kind": k, "ref": ID}


class TestTheRequests:
    def test_the_in_process_request_takes_a_card_and_normalises_it(self):
        req = SendMessageRequest(content="x", card={"kind": "STORY".lower(), "ref": ID.upper(), "html": "<b>"})
        assert req.card == {"kind": "story", "ref": ID}

    @pytest.mark.parametrize("bad", [{"kind": "timeline", "ref": ID}, {"kind": "story", "ref": "nope"}, "story", {}])
    def test_the_in_process_request_refuses_what_is_not_a_card(self, bad):
        with pytest.raises(ValidationError):
            SendMessageRequest(content="x", card=bad)

    def test_the_public_route_refuses_any_card_even_a_valid_one(self):
        for card in ({"kind": "story", "ref": ID}, {"kind": "timeline", "ref": "x"}, "story", {}):
            with pytest.raises(ValidationError) as e:
                HttpSendMessageRequest(content="x", card=card)
            assert "card" in str(e.value)

    def test_the_public_route_without_a_card_is_unchanged(self):
        req = HttpSendMessageRequest(content="hello")
        assert req.card is None and req.event_context is None

    def test_a_card_reaches_the_stored_metadata_and_is_independent_of_the_other_namespaces(self):
        assert _combined_msg_metadata(SendMessageRequest(content="x", card={"kind": "doc", "ref": ID})) == {"card": {"kind": "doc", "ref": ID}}
        both = _combined_msg_metadata(SendMessageRequest(content="x", card={"kind": "doc", "ref": ID}, message_kind="request"))
        assert both == {"activation": {"kind": "request"}, "card": {"kind": "doc", "ref": ID}}
        assert _combined_msg_metadata(SendMessageRequest(content="x")) is None


def _msg(meta, deleted=False):
    return SimpleNamespace(
        id=uuid.uuid4(), conversation_id=uuid.uuid4(), thread_id=None, reply_count=0, last_reply_at=None, sender_id=uuid.uuid4(), content="" if deleted else "hello", mentioned_ids=[],
        attachments=[], created_at=__import__("datetime").datetime(2026, 11, 26), edited_at=None, deleted_at=__import__("datetime").datetime(2026, 11, 26) if deleted else None,
        msg_metadata=meta, __dict__={"msg_metadata": meta},
    )


class TestThePayload:
    def test_a_stored_card_is_served(self):
        assert _card_payload(_msg({"card": {"kind": "story", "ref": ID}})) == {"card": {"kind": "story", "ref": ID}}

    @pytest.mark.parametrize("stored", [None, {}, {"card": None}, {"card": {"kind": "timeline", "ref": ID}}, {"card": {"kind": "story", "ref": "x"}}, {"card": "story"}, "not-a-dict"])
    def test_a_stored_value_that_does_not_fit_is_served_as_no_card(self, stored):
        assert _card_payload(_msg(stored)) == {"card": None}

    def test_extra_stored_keys_are_not_served(self):
        assert _card_payload(_msg({"card": {"kind": "story", "ref": ID, "html": "<b>"}})) == {"card": {"kind": "story", "ref": ID}}

    def test_the_message_payload_carries_the_card_key_always_and_a_tombstone_serves_none(self):
        live = _msg({"card": {"kind": "gate", "ref": ID}})
        none = _msg(None)
        gone = _msg({"card": {"kind": "gate", "ref": ID}}, deleted=True)
        for m, want in ((live, {"kind": "gate", "ref": ID}), (none, None), (gone, None)):
            out = _msg_payload(m, None)
            assert "card" in out and out["card"] == want
