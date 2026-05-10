from __future__ import annotations

import sys

from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address


def _rate_key(request: Request) -> str:
    """IP 기반 rate key — API Key 요청은 키별 별도 공간으로 분리 (높은 임계값 효과)."""
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer sk_live_"):
        # API Key마다 독립 공간 → 실질적 높은 임계값
        return f"api_key:{auth[7:37]}"
    return get_remote_address(request)


_TESTING = "pytest" in sys.modules

limiter = Limiter(
    key_func=_rate_key,
    enabled=not _TESTING,
)
