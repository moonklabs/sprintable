"""story #4536 (E-DESKTOP-2 C-2) — watches that live on the server, past the agent's session (3 tools).

A watch fires once, as a `watch.fired` event on the agent's own stream — after a restart the agent gets it first."""
from __future__ import annotations

from typing import Literal

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class WatchInput(SprintableInput):
    condition: Literal["github.pr_merged", "github.pr_checks_completed", "deploy.serving"]
    target: dict  # {repo, pr} · deploy.serving: {service: "backend", repo, pr} or {service: "backend", commit}
    expires_in_hours: int | None = None  # 1–720 (default 168)


class UnwatchInput(SprintableInput):
    watch_id: str


class ListWatchesInput(SprintableInput):
    include_done: bool | None = None


async def watch(args: WatchInput) -> list[TextContent]:
    body: dict = {"condition": args.condition, "target": args.target}
    if args.expires_in_hours is not None:
        body["expires_in_hours"] = args.expires_in_hours
    try:
        return ok(await client.post("/api/v2/watches", json=body))
    except Exception as exc:  # noqa: BLE001
        return err(exc)


async def unwatch(args: UnwatchInput) -> list[TextContent]:
    try:
        return ok(await client.delete(f"/api/v2/watches/{args.watch_id}"))
    except Exception as exc:  # noqa: BLE001
        return err(exc)


async def list_watches(args: ListWatchesInput) -> list[TextContent]:
    params = {"include_done": "true"} if args.include_done else None
    try:
        return ok(await client.get("/api/v2/watches", params=params))
    except Exception as exc:  # noqa: BLE001
        return err(exc)
