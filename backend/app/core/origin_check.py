"""story 4796 — one definition of «an origin» for the public API address (`PUBLIC_API_URL`) and for the one-off job that rewrites stored links.

An origin here is `https://host[:port]` (plain `http` only for localhost / 127.0.0.1): no path, query, fragment or credentials, a numeric port in range. A trailing slash is accepted and dropped.
"""
from __future__ import annotations

from urllib.parse import urlsplit


def parse_origin(value: str, *, allow_empty: bool = False) -> str:
    """The normalised origin (no trailing slash). `ValueError` when it is not one. An empty value is `""` only with `allow_empty` (an unset setting); a value made only of slashes is never empty."""
    raw = (value or "").strip()
    if not raw:
        if allow_empty:
            return ""
        raise ValueError("an origin is required")
    cleaned = raw.rstrip("/")
    if not cleaned:
        raise ValueError(f"not an origin: {raw!r}")
    parts = urlsplit(cleaned)
    try:
        port = parts.port  # raises ValueError for a non-numeric or out-of-range port
    except ValueError as exc:
        raise ValueError(f"not an origin (bad port): {raw!r}") from exc
    loopback = parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1")
    if not (parts.scheme == "https" or loopback) or not parts.hostname or parts.path or parts.query or parts.fragment or parts.username or parts.password:
        raise ValueError("an origin is https://host[:port] (http only for localhost), with no path, query, fragment or credentials")
    if port == 0 or parts.netloc.endswith(":"):
        raise ValueError("an empty or zero port is not a port")
    return cleaned
