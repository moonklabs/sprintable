"""story 4669 (U6 · AC3) — a setup code lives 30 minutes (it was 10: a person who signed up on the web, installed the app and
came back to the setup page met «설정 시간이 지났어요»). The desktop app polls the exchange until the `expires_at` this answer
carries (setup-flow.ts), so the number lives in SETUP_CODE_TTL alone. Reverted (10 minutes) → both tests go red.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.services.desktop_setup import SETUP_CODE_TTL
from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    _client,
    _dispose_global_engine_after_test,
    _pkce,
    _sql,
    anyio_backend,
    world,
)

pytestmark = pytest.mark.anyio


def test_the_ttl_is_thirty_minutes():
    assert SETUP_CODE_TTL == timedelta(minutes=30)


async def test_a_new_code_expires_thirty_minutes_from_now(world):
    _, challenge = _pkce()
    async with _client() as c:
        before = datetime.now(timezone.utc)
        r = await c.post("/api/v2/desktop/setup-codes", json={"challenge": challenge, "device_name": "d4669 laptop"})
        after = datetime.now(timezone.utc)
    assert r.status_code == 201, r.text
    expires_at = datetime.fromisoformat(r.json()["expires_at"].replace("Z", "+00:00"))
    assert before + timedelta(minutes=30) - timedelta(seconds=5) <= expires_at <= after + timedelta(minutes=30) + timedelta(seconds=5)
    # the row the exchange reads carries the same moment
    row = await _sql(fetch=f"SELECT expires_at FROM desktop_setups WHERE id='{r.json()['setup_id']}'")
    assert abs((row[0][0] - expires_at).total_seconds()) < 1
