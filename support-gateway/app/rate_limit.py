"""story #3259 AC3 — org 스코프 rate limit. backend/app/core/rate_limit.py(IP·API Key 축)와
독립된 인스턴스 — 이 서비스는 org_id(위임 토큰 클레임)로만 키를 잡는다. redis_url 미설정
시 memory://(단일 Cloud Run 인스턴스 전제) — dev 기본, prod에서 다중 인스턴스로 스케일되면
Redis(전용 인스턴스, backend와 공유 안 함) 필요. 이 격차는 PR에 명시(스케일 전제 미충족 시
org별 한도가 인스턴스 수만큼 느슨해짐 — backend rate_limit.py의 story #2444 동형 트레이드오프)."""
from __future__ import annotations

import sys

from fastapi import Request
from slowapi import Limiter

from app.config import settings

_TESTING = "pytest" in sys.modules


def _org_scoped_key(request: Request) -> str:
    org_id = getattr(request.state, "delegated_org_id", None)
    return f"org:{org_id}" if org_id else "unscoped"


limiter = Limiter(
    key_func=_org_scoped_key,
    storage_uri=settings.redis_url or "memory://",
    enabled=not _TESTING,
)
