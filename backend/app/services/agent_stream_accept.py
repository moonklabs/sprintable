"""story 4788 (INFRA-DIET ③ · PO 10-26) — which event types an agent stream connection is sent.

`GET /api/v2/agent/stream` replays every event after the agent's cursor (`recipient_seq > max(acked_seq, Last-Event-ID)`) on each connect. A client acts on a few event types only
(the Claude Code plugin, the SDKs and the desktop app each have a list) and the plugin drops the rest BEFORE acking them: the cursor stops at the last event it acted on, and everything
after it — events nobody there acts on — comes again on every reconnect (prod: one Bun stream 25.9 MB, ≈44 GB a day).

A client names the types it acts on with `X-Sprintable-Accept-Events: a, b, c`; the connection is then sent those types only — on connect AND on every live wake. It changes WHAT THIS
CONNECTION IS SENT and nothing else: the agent's durable cursor is never moved by it (an ack is cumulative and per agent, so another connection of the same agent — the desktop app that acts on
`desktop.*` — still receives everything it needs). No header, or one that cannot be read whole: everything, as before. The server does not guess a client from its user agent: the Claude Code
plugin and the TypeScript SDK adapters are both Bun with the same headers, and the SDK acts on types the plugin drops.
"""
from __future__ import annotations

import re

ACCEPT_EVENTS_HEADER = "x-sprintable-accept-events"
_TOKEN = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
MAX_DECLARED_TYPES = 32


def parse_accept_header(value: str | None) -> frozenset[str] | None:
    """The declared set, or None when there is no (usable) declaration. A malformed one is ignored as a whole — never a partial reading that could drop what the client acts on."""
    if not value:
        return None
    parts = [p.strip() for p in value.split(",")]
    parts = [p for p in parts if p]
    if not parts or len(parts) > MAX_DECLARED_TYPES or not all(_TOKEN.match(p) for p in parts):
        return None
    return frozenset(parts)


def accepted_event_types(headers) -> tuple[frozenset[str] | None, str]:
    """(the types this connection is sent — None = all, how it was decided: `declared` · `all`)."""
    declared = parse_accept_header(headers.get(ACCEPT_EVENTS_HEADER))
    return (declared, "declared") if declared is not None else (None, "all")
