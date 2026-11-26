"""story 5034 (C4) — the chat card's CLOSED vocabulary: an agent names «a kind + a reference» and the SERVER writes `msg_metadata['card'] = {kind, ref}`; the web draws it with a part it registered
itself (apps/web/src/components/chat/cards/card-kinds.ts keeps the same list — `tests/test_5034_chat_card_field.py` holds the two equal). There is no HTML, no title and no URL in that shape: only two words.

A client can never write it (the public message route refuses a `card` with 422 — the same rule as `event_context`, story 4894); the server's own in-process callers set it. Whatever is stored is read
back through `normalize_card` too, so a value that does not fit the shape (an older write · a hand-edited row) is served as «no card», never as a card.
"""
from __future__ import annotations

import uuid
from typing import Any

# Order and spelling are the web's `CARD_KINDS`. A kind this list does not have is refused at write; an older web meeting a newer kind draws its «this app version cannot show it» card.
CARD_KINDS: tuple[str, ...] = ("story", "epic", "task", "sprint", "doc", "artifact", "hypothesis", "evidence", "gate", "kanban", "deploy")


def normalize_card(raw: Any) -> dict[str, str] | None:
    """`{kind, ref}` → the stored/served form (`ref` a lower-case UUID), or None when it is not a card. Only the two words survive: any other key is dropped, never carried."""
    if not isinstance(raw, dict):
        return None
    kind, ref = raw.get("kind"), raw.get("ref")
    if not isinstance(kind, str) or kind not in CARD_KINDS or not isinstance(ref, str):
        return None
    try:
        parsed = uuid.UUID(ref)
    except ValueError:
        return None
    if str(parsed) != ref.lower():  # `uuid.UUID` also takes braces / urn: / no-dash forms — the stored form is the plain dashed one only
        return None
    return {"kind": kind, "ref": str(parsed)}
