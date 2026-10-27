"""story 4796 — the one place that decides which origin a PUBLIC link or a bound origin is built from.

A link that is stored (the public link of a published hosted-site post) or bound into a signed record (the `web_origin` of a device-proof challenge) must not be built from the request's own host: behind the VM's
pass-through front door the request's host is the Cloud Run host (the door sets `Host` to it), so every such link was written with `run.app` and would answer 404 once the Cloud Run backend is gone, and on the VM
it is whatever the front door passes. `settings.public_api_url` (env `PUBLIC_API_URL`) is the public address of this API; empty keeps the old behaviour (the request's host), which is what a self-hosted or local run wants.
"""
from __future__ import annotations

from starlette.requests import Request

from app.core.config import settings


def public_api_origin(request: Request | None = None, *, fallback: str = "") -> str:
    """`scheme://host[:port]`, no trailing slash. Order: the configured public address → `fallback` (a setting the caller has, e.g. `settings.backend_url`) → the request's own host."""
    configured = (settings.public_api_url or "").strip().rstrip("/")
    if configured:
        return configured
    if fallback and fallback.strip():
        return fallback.strip().rstrip("/")
    return str(request.base_url).rstrip("/") if request is not None else ""
