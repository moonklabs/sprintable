"""story #3259 AC3 — org 스코프 rate limit이 실제로 429를 반환하는지.

app/rate_limit.py의 Limiter는 backend/app/core/rate_limit.py와 동형으로 `enabled=not
_TESTING`(pytest 하에서 기본 비활성 — 다른 테스트들의 플레이크 방지, story #2444 동형
관례)이라, 이 파일만 명시적으로 강제 활성화해 실제 429 집행을 증명한다."""
from __future__ import annotations

import pytest

from app.config import settings
from app.rate_limit import limiter
from tests.conftest import OTHER_ORG_ID, make_token


@pytest.fixture(autouse=True)
def _tight_limit_and_enable(monkeypatch):
    monkeypatch.setattr(settings, "session_rate_limit", "2/minute")
    monkeypatch.setattr(limiter, "enabled", True)


async def test_exceeds_limit_returns_429(client):
    headers = {"Authorization": f"Bearer {make_token(OTHER_ORG_ID)}"}
    for _ in range(2):
        resp = await client.post("/api/v1/sessions", headers=headers)
        assert resp.status_code == 200
    resp = await client.post("/api/v1/sessions", headers=headers)
    assert resp.status_code == 429
