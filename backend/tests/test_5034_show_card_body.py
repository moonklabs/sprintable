"""story 5034 (C4) — the body of «show a card in chat» takes what the MCP client puts on every POST.

Found on the dev lap (11-26): `sprintable_show_in_chat` answered 422 «project_id / org_id / created_by: Extra inputs are not permitted» on EVERY call — the MCP client (`sprintable_mcp/api_client.py`)
adds its key's context to each POST body, and the body model refused all extras. Red when: those words are refused again · the list of words the client adds grows and this body does not take them
(the scan below reads the client's own lines) · any OTHER extra word is accepted (a client must still not be able to stamp more than kind · ref · note) · the context words are carried into what is posted
(who the agent is, its org and its project come from its key, never from the body).
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.routers.conversations import ShowCardRequest

ID = "0d6e953f-6d43-42c1-a87c-b023544497db"
CLIENT = Path(__file__).resolve().parents[1] / "sprintable_mcp" / "api_client.py"


def _client_context_words() -> set[str]:
    text = CLIENT.read_text(encoding="utf-8")
    block = text.split('if method.upper() in ("POST", "PUT", "PATCH") and json is not None:', 1)[1].split("async with httpx", 1)[0]
    return set(re.findall(r'json\.get\("([a-z_]+)"\)', block))


def test_the_client_adds_the_three_words_this_body_knows_about():
    # the scan itself must see the lines (a rename of the block would make the next test vacuous)
    assert _client_context_words() == {"project_id", "org_id", "created_by"}


def test_every_word_the_client_adds_is_accepted():
    body = {"kind": "story", "ref": ID, **{w: "11111111-2222-4333-8444-555555555555" for w in _client_context_words()}}
    req = ShowCardRequest(**body)
    assert (req.kind, req.ref) == ("story", ID)


def test_the_context_words_are_not_carried_on():
    req = ShowCardRequest(kind="story", ref=ID, note="n", project_id="p", org_id="o", created_by="c")
    assert req.model_dump() == {"kind": "story", "ref": ID, "note": "n"}


@pytest.mark.parametrize("extra", [{"card": {"kind": "story", "ref": ID}}, {"sender_id": ID}, {"html": "<b>"}, {"title": "x"}])
def test_any_other_extra_word_is_still_refused(extra):
    with pytest.raises(ValidationError):
        ShowCardRequest(kind="story", ref=ID, **extra)
