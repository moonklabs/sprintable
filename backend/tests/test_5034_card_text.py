"""story 5034 (C4) — the line of text a card message carries, in words a first-time reader understands (PO, dev lap 11-26: the refused card's text was the bare word «story»).

Red when: a kind an agent may ask to show has no word in a language · the line is the bare kind word again · the refused line differs between «does not exist» and «not yours» (it takes no object
and no agent — only the kind and the language) · the refused line does not say it could not be shown · an unknown language falls to something other than Korean.
"""
from __future__ import annotations

import pytest

from app.services.chat_card import TOOL_KINDS, card_text
from app.services.agent_onboarding_config import SUPPORTED_LOCALES


@pytest.mark.parametrize("locale", SUPPORTED_LOCALES)
@pytest.mark.parametrize("kind", TOOL_KINDS)
def test_every_kind_the_tool_takes_has_a_plain_line_in_every_language(kind, locale):
    ok, no = card_text(kind, refused=False, locale=locale), card_text(kind, refused=True, locale=locale)
    assert kind not in (ok, no) or kind == "doc" and locale == "en"  # (en «doc» is also the kind word — it is inside a sentence, never alone)
    assert ok != no and len(ok.split()) >= 2 and len(no.split()) >= 3


def test_the_refused_line_says_it_could_not_be_shown():
    assert card_text("story", refused=True, locale="ko") == "볼 수 없는 장 카드"
    assert card_text("story", refused=True, locale="en") == "A story card that could not be shown"
    assert card_text("kanban", refused=False, locale="ko") == "스프린트 칸반 카드"
    assert card_text("doc", refused=False, locale="en") == "A doc card"


def test_an_unknown_language_reads_as_korean():
    assert card_text("epic", refused=True, locale="fr") == card_text("epic", refused=True, locale="ko")


def test_the_line_takes_no_object_and_no_agent():
    import inspect
    assert list(inspect.signature(card_text).parameters) == ["kind", "refused", "locale"]  # nothing of the object or of who asked can reach the text
