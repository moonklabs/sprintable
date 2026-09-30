"""story #4430 — an agent sees and lifts its own blocks (2 tools).

A person has the settings section «차단한 사용자»; an agent had no way to see its blocks at all, so a test block made on
2026-08-03 kept silently dropping a teammate's 1:1 messages for two months. These wrap the existing block API as it is
(`/api/v2/user-blocks`): list the caller's blocks, remove one. Creating a block is not offered here — the gap was not
knowing and not being able to lift one.
"""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class ListUserBlocksInput(SprintableInput):
    pass


class RemoveUserBlockInput(SprintableInput):
    member_id: str


async def list_user_blocks(args: ListUserBlocksInput) -> list[TextContent]:
    """The caller's blocks — who the caller blocked (their member id) and since when. Messages from a blocked member are
    left out of the caller's notifications and events."""
    try:
        return ok(await client.get("/api/v2/user-blocks"))
    except Exception as exc:
        return err(exc)


async def remove_user_block(args: RemoveUserBlockInput) -> list[TextContent]:
    """Lift the caller's block on one member — their messages reach the caller again. Removing a block that does not exist
    is fine (no change)."""
    try:
        await client.delete(f"/api/v2/user-blocks/{args.member_id}")
        return ok({"member_id": args.member_id, "blocked": False})
    except Exception as exc:
        return err(exc)
