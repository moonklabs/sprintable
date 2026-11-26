"""story 5034 (C4 step 4) — 「보여 줘」: show an object in a chat room as a card.

The agent names ONLY a kind and a reference (and, optionally, one short sentence); the server decides what the card is and posts it as the agent's message when the agent can see the object. When it cannot — or the
object does not exist; the two are not told apart — the answer is the same 404 «Target not found» (no list of who can see it, no hint). The room's people see a refused card drawn by THEIR rights.
"""
from __future__ import annotations

from typing import Literal

from mcp.types import TextContent
from pydantic import Field

from ..api_client import client
from ..response import err, ok
from .chat import ConversationScopedInput


class ShowInChatInput(ConversationScopedInput):
    kind: Literal["story", "epic", "task", "sprint", "doc", "artifact", "hypothesis", "evidence", "kanban"]
    ref: str = Field(description="The object's id (a UUID). For kind `kanban` it is the SPRINT's id (the card is that sprint's board).")
    note: str | None = Field(default=None, max_length=200, description="One short sentence to go with the card (optional).")


async def show_in_chat(args: ShowInChatInput) -> list[TextContent]:
    """Show a story · epic · task · sprint · doc · artifact · hypothesis · evidence (or a sprint's board, kind `kanban`) in this conversation as a card the people in the room can open."""
    payload: dict = {"kind": args.kind, "ref": args.ref}
    if args.note:
        payload["note"] = args.note
    try:
        data = await client.post(f"/api/v2/conversations/{args.conversation_id}/card", json=payload)
    except Exception as exc:
        return err(exc)
    return ok(data if isinstance(data, dict) else {})
