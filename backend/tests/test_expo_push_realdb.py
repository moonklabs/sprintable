"""E-MOBILE M0·S3: Expo 발송 real-DB 왕복 — dispatch_notification 경로 실구동 + mock Expo.

AC1(dispatch_notification 경로 발송·비-EE 무동작) + AC2(DeviceNotRegistered→is_active=false 왕복).
실 PG + 실 파이프라인(dispatch_notification) 구동, Expo HTTP 만 mock(토큰별 ticket 반환). DB env 없으면 skip.
"""
from __future__ import annotations

import json
import os
import uuid
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("LICENSE_CONSENT", "agreed")  # EE 게이트 on (app import 前·단독 실행 권장)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not _REAL_DB_URL, reason="real-DB URL(PARITY/ALEMBIC_DATABASE_URL) 미설정 — skip"
)

ORG = uuid.UUID("d3000000-0000-0000-0000-0000000000e1")
MEMBER_X = uuid.UUID("d3000000-0000-0000-0000-0000000000a1")
TOKEN_GOOD = "ExponentPushToken[s3-good-0001]"
TOKEN_BAD = "ExponentPushToken[s3-bad-0002]"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


class _Resp:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class _FakeExpo:
    """Expo send mock: 요청 body(messages)를 캡처하고 토큰별 ticket(good=ok·bad=DeviceNotRegistered) 반환."""
    def __init__(self):
        self.posted_tokens: list[str] = []
        self.posted_titles: list[str] = []

    def __call__(self, *a, **k):
        cm = AsyncMock()
        cm.__aenter__ = AsyncMock(return_value=self)
        cm.__aexit__ = AsyncMock(return_value=False)
        return cm

    async def post(self, url, content=None, headers=None):
        messages = json.loads(content)
        tickets = []
        for m in messages:
            self.posted_tokens.append(m["to"])
            self.posted_titles.append(m.get("title"))
            if m["to"] == TOKEN_BAD:
                tickets.append({"status": "error", "details": {"error": "DeviceNotRegistered"}})
            else:
                tickets.append({"status": "ok", "id": "ticket-1"})
        return _Resp(200, {"data": tickets})


@pytest.mark.anyio
async def test_dispatch_notification_sends_expo_and_expires_dead_token_realdb():
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.services.notification_dispatch import dispatch_notification

    engine = create_async_engine(_async_url())
    SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

    async def _seed():
        async with SessionLocal() as s:
            await s.execute(text("DELETE FROM push_devices WHERE org_id=:o"), {"o": str(ORG)})
            await s.execute(text("DELETE FROM organizations WHERE id=:o"), {"o": str(ORG)})
            await s.execute(
                text("INSERT INTO organizations (id,name,slug,plan) VALUES (:o,'S3 Org','s3-expo','free')"),
                {"o": str(ORG)},
            )
            for tok in (TOKEN_GOOD, TOKEN_BAD):
                await s.execute(
                    text(
                        "INSERT INTO push_devices (id,org_id,member_id,expo_push_token,platform,is_active) "
                        "VALUES (gen_random_uuid(),:o,:m,:t,'ios',true)"
                    ),
                    {"o": str(ORG), "m": str(MEMBER_X), "t": tok},
                )
            await s.commit()

    fake = _FakeExpo()
    try:
        await _seed()

        # dispatch_notification 실구동(EE on) — Expo HTTP 만 mock.
        async with SessionLocal() as s:
            with patch("ee.services.expo_push.httpx.AsyncClient", new=fake):
                await dispatch_notification(
                    s, org_id=ORG, event_type="gate_pending",
                    target_member_ids=[MEMBER_X], title="게이트 대기", body="승인 필요",
                )
            await s.commit()

        # 발송 실증: 두 토큰 모두 페이로드에 실림 + 제목 전달
        assert set(fake.posted_tokens) == {TOKEN_GOOD, TOKEN_BAD}
        assert "게이트 대기" in fake.posted_titles

        # DeviceNotRegistered 만료 왕복: BAD=비활성·GOOD=활성 유지
        async with SessionLocal() as s:
            rows = (await s.execute(
                text("SELECT expo_push_token, is_active FROM push_devices WHERE org_id=:o"),
                {"o": str(ORG)},
            )).all()
        state = {tok: active for tok, active in rows}
        assert state[TOKEN_BAD] is False, "DeviceNotRegistered 토큰이 만료(is_active=false) 안 됨"
        assert state[TOKEN_GOOD] is True, "정상 토큰이 잘못 만료됨"
    finally:
        async with SessionLocal() as s:
            await s.execute(text("DELETE FROM organizations WHERE id=:o"), {"o": str(ORG)})  # cascade
            await s.commit()
        await engine.dispose()
