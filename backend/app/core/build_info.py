"""story #4513 (PO 01:53Z) — what this instance is running, for the unauthenticated health read.

The only way to confirm that a deploy is serving was `gcloud run services describe` (admin credentials); with those expired
(10-03) a deploy could not be closed. The image now carries its commit and build time (Dockerfile: a last layer keyed by the
APP_COMMIT_SHA build-arg — rebuilt on every commit, so the time is never a cached layer's), and Cloud Run gives the revision
(K_REVISION). Each falls back to «unknown» — never a guess. No secret and no internal address is read here.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

_BUILD_TIME_FILE = Path(os.environ.get("APP_BUILD_TIME_FILE", "/app/.build_time"))
_SHA = re.compile(r"[0-9a-f]{7,40}")
_REVISION = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")
_TIME = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
UNKNOWN = "unknown"


def _shape(value: str | None, pattern: re.Pattern[str]) -> str:
    """A value only if it has its expected shape — anything else is reported as unknown, never echoed."""
    value = (value or "").strip()
    return value if pattern.fullmatch(value) else UNKNOWN


def build_info() -> dict[str, str]:
    try:
        build_time = _BUILD_TIME_FILE.read_text(encoding="utf-8")
    except OSError:
        build_time = None
    return {
        "commit_sha": _shape(os.environ.get("APP_COMMIT_SHA"), _SHA),
        "revision": _shape(os.environ.get("K_REVISION"), _REVISION),
        "build_time": _shape(build_time, _TIME),
    }
