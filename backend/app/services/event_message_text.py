"""story 4921 (second PR) — the one line a PERSON sees for an event message on the server's own surfaces (the `summary` the bell and the live frames carry, the body of a notification, the activity log's preview).

The `content` of an event message is what an AGENT reads: «[이벤트] <key>» (or «[Event] <key>»), then «- key: value» lines — a slug, ids and field names (events.py `_generic_event_message_lines` / the stage renderers).
It is the whole channel for agents (story 4076) and stays. A person must not read it, so every surface that turns the content into a preview calls `human_event_text` first:
- `preset.steer.instruct` → «방향 전환 · {instruction}[ → {target's name}]» (the name comes from `refs.target`, resolved at publish; none for a message published before it existed — then no « → name»);
- any other event → «이벤트», plus the person's own words from the payload when there are some («이벤트 · {words}») — `instruction · message · summary · note`, first line (never `title / body / content / reason`: workflow and recipe payloads carry slugs and paths
  there; never a line that is an id, a path, a link or an entity token); cut by code point;
- a content that is NOT machine text (a sentence somebody wrote, e.g. the publish-stopped explanation) → None: the caller keeps it.
The definition's own name (which the web's room list and inbox add) is not read here: this runs on a hot path with no database; the surface that can read it says it.
The web has the same rules in `event-block-card.tsx` (`composeEventPreviewFallback`) — keep the two in step (the tests of both pin the same samples).
"""
from __future__ import annotations

import re
from typing import Any

from app.services.i18n_catalog import t

_HUMAN_TEXT_FIELDS = ("instruction", "message", "summary", "note")
_PREVIEW_TEXT_MAX = 60
_NOT_WORDS_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|^/|^[a-z][a-z0-9+.-]*://|entity:[a-z_]+:",
    re.IGNORECASE,
)
_STEER_KEY = "preset.steer.instruct"
_SENTINEL = "\x00"


def _machine_prefixes() -> tuple[str, ...]:
    """the localized header the server writes in front of an event message's content — taken from the catalog, never retyped (a changed header cannot leave a stale detector)"""
    return tuple(t("events.event_line_header", loc, event_key=_SENTINEL).split(_SENTINEL)[0] for loc in ("ko", "en"))


def is_machine_event_content(content: str | None) -> bool:
    if not isinstance(content, str):
        return False
    return any(content.startswith(p) and len(content) > len(p) and not content[len(p)].isspace() for p in _machine_prefixes())


def first_human_line(value: Any, max_chars: int = _PREVIEW_TEXT_MAX) -> str | None:
    if not isinstance(value, str):
        return None
    line = next((ln.strip() for ln in value.split("\n") if ln.strip()), "")
    if not line or _NOT_WORDS_RE.search(line):
        return None
    return line if len(line) <= max_chars else line[:max_chars] + "…"  # `str` slices by code point


def human_event_text(content: str | None, event: dict | None, locale: str = "ko") -> str | None:
    """the person-readable line for an event message, or None when `content` is not machine text (the caller keeps it)"""
    if not is_machine_event_content(content):
        return None
    card = event if isinstance(event, dict) else {}
    payload = card.get("payload") if isinstance(card.get("payload"), dict) else {}
    refs = card.get("refs") if isinstance(card.get("refs"), dict) else {}
    if card.get("event_key") == _STEER_KEY:
        instruction = first_human_line(payload.get("instruction"))
        if instruction:
            line = t("events.preview_steer", locale, instruction=instruction)
            target = refs.get("target")
            if isinstance(target, dict):
                name = target.get("name") if target.get("found") and isinstance(target.get("name"), str) else (
                    t("events.preview_member_missing", locale) if target.get("found") is False else None
                )
                if name:
                    line = t("events.preview_steer_target", locale, line=line, name=name)
            return line
    head = t("events.preview_generic", locale)
    for field in _HUMAN_TEXT_FIELDS:
        words = first_human_line(payload.get(field))
        if words:
            return t("events.preview_with_words", locale, head=head, words=words)
    return head
