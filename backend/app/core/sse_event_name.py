"""story #4692 [SEC] — the one rule for an event's name where it meets an SSE `event:` line.

An SSE frame is `event: <name>\\n…`. A name that carries a CR/LF (or any control character) ends that line and starts a new one, so whoever
chose the name could plant frames on another agent's stream (`event: superseded` …). Two defences, same shape, so no writer can reopen it:

- the API accepts an event type only in the closed shape below (`validate_event_type` → 422 at `POST /api/v2/events` and the agent inbox webhook);
- every place that writes `event: {name}` passes the name through `sse_event_name` — a name outside the shape is NOT written: the frame is still
  sent (its id and data intact, so the receiver's dense sequence numbers hold) under the neutral `unknown_event`, which no consumer acts on.

The shape was measured from the code (every literal event type any producer creates: `story_assigned` · `conversation.message_created` ·
`conversation:mention` · `a2a.task_message` · `agent.permission_request.changed` …) and the dev DB's DISTINCT values: lower-case letters, digits,
`.` `_` `:` `-`, starting with a letter or digit, 1–64 long.
"""
from __future__ import annotations

import re

EVENT_TYPE_MAX = 64
# fullmatch, never `$`: Python's `$` also matches before a trailing newline — the very thing this guards against
_EVENT_TYPE_RE = re.compile(r"[a-z0-9][a-z0-9._:-]{0,%d}" % (EVENT_TYPE_MAX - 1))
UNKNOWN_EVENT_NAME = "unknown_event"


def is_event_type(value: object) -> bool:
    return isinstance(value, str) and _EVENT_TYPE_RE.fullmatch(value) is not None


def validate_event_type(value: str) -> str:
    """the API's gate (a pydantic field validator): the closed shape or a ValueError → 422"""
    if not is_event_type(value):
        raise ValueError(f"event_type must be 1-{EVENT_TYPE_MAX} characters of a-z 0-9 . _ : - (lower case, starting with a letter or digit)")
    return value


def sse_event_name(value: object) -> str:
    """the writer's gate: the name for an `event:` line — itself when it is in the closed shape, else `unknown_event` (never the raw value)"""
    return value if isinstance(value, str) and _EVENT_TYPE_RE.fullmatch(value) is not None else UNKNOWN_EVENT_NAME
