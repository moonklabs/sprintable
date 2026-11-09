"""story 4869 (lens) — a URL is a credential in this system: the path of a Discord webhook is its secret, query strings carry access tokens. A log line names the HOST, never the URL.

`url_host(url)` — for a log argument; `redact_urls(text)` — for a free text that may contain URLs (an HTTP status error's message holds the whole request URL).
"""
from __future__ import annotations

import re
from urllib.parse import urlsplit

_URL = re.compile(r"https?://[^\s'\"<>)\]]+", re.IGNORECASE)
_UNPARSEABLE = "(unparseable-url)"


def url_host(url: object) -> str:
    """`host` or `host:port` of a URL — no scheme, no user info, no path, no query, no fragment. Anything that is not a URL with a host reads «(unparseable-url)»."""
    try:
        parts = urlsplit(str(url).strip())
        host = parts.hostname
        if not host:
            return _UNPARSEABLE
        return f"{host}:{parts.port}" if parts.port else host
    except ValueError:
        return _UNPARSEABLE


def redact_urls(text: str) -> str:
    """Every URL inside `text` replaced by `scheme://host/…` (the path, query and user info are gone)."""

    def _one(m: re.Match[str]) -> str:
        url = m.group(0)
        host = url_host(url)
        scheme = url.split("://", 1)[0].lower()
        return f"{scheme}://{host}/…"

    return _URL.sub(_one, text)
