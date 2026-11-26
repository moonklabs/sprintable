"""story 5034 (C4) — the chat card's CLOSED vocabulary: an agent names «a kind + a reference» and the SERVER writes `msg_metadata['card'] = {kind, ref}`; the web draws it with a part it registered
itself (apps/web/src/components/chat/cards/card-kinds.ts keeps the same list — `tests/test_5034_chat_card_field.py` holds the two equal). There is no HTML, no title and no URL in that shape: only two words.

A refused card carries a THIRD word, `refused_for` (the agent's member id — a UUID): the server posts the card of an object an agent asked to show but may not see (or that does not exist — the two look
the same on purpose), and the web draws it for each viewer by THEIR rights (a viewer who can see the object is told which agents can; one who cannot sees «not found»). Only the server writes it.

A client can never write it (the public message route refuses a `card` with 422 — the same rule as `event_context`, story 4894); the server's own in-process callers set it. Whatever is stored is read
back through `normalize_card` too, so a value that does not fit the shape (an older write · a hand-edited row) is served as «no card», never as a card.
"""
from __future__ import annotations

import uuid
from typing import Any

# Order and spelling are the web's `CARD_KINDS`. A kind this list does not have is refused at write; an older web meeting a newer kind draws its «this app version cannot show it» card.
CARD_KINDS: tuple[str, ...] = ("story", "epic", "task", "sprint", "doc", "artifact", "hypothesis", "evidence", "gate", "kanban", "deploy")


# What an agent may ask to be shown with the `show card` tool (the kinds with a project we can check an agent's access against; `kanban` is the board of a sprint — its reference is the sprint's id).
TOOL_KINDS: tuple[str, ...] = ("story", "epic", "task", "sprint", "doc", "artifact", "hypothesis", "evidence", "kanban")


# The line of text a card message carries (the web draws the CARD, not this line — it is what an agent that reads the room through MCP, or a notification, sees). In words a first-time reader understands, never the
# bare kind word; the words live in the server's message catalogue (`app/services/i18n_catalog.py`, `chat_card.*`). The refused line is the SAME for «does not exist» and «not yours» (it names the kind only — never
# the object, never who can see it).
def card_text(kind: str, *, refused: bool, locale: str) -> str:
    from app.services.i18n_catalog import t

    word = t(f"chat_card.kind.{kind}", locale)
    return t("chat_card.text_refused" if refused else "chat_card.text_shown", locale, kind=word)


def resolver_kind(kind: str) -> str:
    """the entity registry's kind whose project decides who may see the card's object (a board is its sprint's)"""
    return "sprint" if kind == "kanban" else kind


def _plain_uuid(v: Any) -> str | None:
    if not isinstance(v, str):
        return None
    try:
        parsed = uuid.UUID(v)
    except ValueError:
        return None
    return str(parsed) if str(parsed) == v.lower() else None  # `uuid.UUID` also takes braces / urn: / no-dash forms — the stored form is the plain dashed one only


def normalize_card(raw: Any) -> dict[str, str] | None:
    """`{kind, ref[, refused_for]}` → the stored/served form (UUIDs lower-case), or None when it is not a card. Only these words survive: any other key is dropped, never carried.
    A `refused_for` that is present but is not a plain UUID makes the whole thing not a card (fail closed)."""
    if not isinstance(raw, dict):
        return None
    kind = raw.get("kind")
    ref = _plain_uuid(raw.get("ref"))
    if not isinstance(kind, str) or kind not in CARD_KINDS or ref is None:
        return None
    out = {"kind": kind, "ref": ref}
    if "refused_for" in raw and raw["refused_for"] is not None:
        who = _plain_uuid(raw["refused_for"])
        if who is None:
            return None
        out["refused_for"] = who
    return out
