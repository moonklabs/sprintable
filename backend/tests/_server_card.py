"""story 4894 — send a chat message the way the SERVER's own publisher does: in-process, with an `event_context` card.

`event_context` (the card of a message the server published) cannot be sent to the public HTTP route any more — that route's body model refuses it with 422. The server's publisher
(`publish_registry_event`) builds a `SendMessageRequest` and hands it to the message function in-process; tests that need a message WITH a card (to look at what the readers of the room
and the notification rows get from it) take the same road here instead of the HTTP one."""
from __future__ import annotations

import uuid


async def say_with_server_card(Session, w, caller, conv_id, content, *, event_context, mentioned=()):
    """send `content` as `caller` with `event_context` through the in-process message function; the room's background work runs after the commit, as the HTTP road's does.
    Returns the new message's id."""
    from fastapi import BackgroundTasks

    from app.dependencies.auth import AuthContext
    from app.routers.conversations import SendMessageRequest, send_message
    from tests.test_4846_org_chat_rooms_realdb import _callers

    kind, _member, user = _callers(w)[caller]
    claims = {"org_id": str(w.org)} if kind == "human" else {"org_id": str(w.org), "api_key_id": str(uuid.uuid4())}
    auth = AuthContext(user_id=str(user), email=f"{kind}@test", claims={"app_metadata": claims})
    tasks = BackgroundTasks()
    async with Session() as s:
        body = SendMessageRequest(content=content, mentioned_ids=[str(m) for m in mentioned], event_context=event_context)
        out = await send_message(conv_id, body, tasks, db=s, auth=auth, org_id=w.org)
        await s.commit()
    await tasks()
    return uuid.UUID(str((out.get("data") or out)["id"]))
