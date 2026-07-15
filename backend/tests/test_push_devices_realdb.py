"""E-MOBILE M0·S2: push_devices 등록→조회→폐기 왕복 real-DB 통합 (AC1 curl 왕복 재현).

실 Postgres(PARITY/ALEMBIC_DATABASE_URL·alembic upgrade heads 적용)에 실 앱(ASGI)을 붙여
등록→조회→재등록(멱등)→폐기 왕복 + IDOR(타 멤버 미노출/미폐기)을 실증. DB env 없으면 skip.

resolve_member 축은 unit(test_push_devices_ee) 커버 — 여기선 _get_caller_member_id 를 오버라이드해
push_devices 데이터 경로(UNIQUE upsert·member-scope·FK)만 실 DB 로 검증한다.
"""
from __future__ import annotations

import os
import uuid

import pytest

# EE 라우터는 is_ee_enabled 일 때만 마운트 — app import 前에 설정. (이 파일은 단독 실행 권장)
os.environ.setdefault("LICENSE_CONSENT", "agreed")

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not _REAL_DB_URL, reason="real-DB URL(PARITY/ALEMBIC_DATABASE_URL) 미설정 — skip"
)

ORG = uuid.UUID("d0000000-0000-0000-0000-0000000000e1")
MEMBER_X = uuid.UUID("d0000000-0000-0000-0000-0000000000a1")
MEMBER_Y = uuid.UUID("d0000000-0000-0000-0000-0000000000a2")
TOKEN_A = "ExponentPushToken[s2-round-trip-AAAA]"
TOKEN_B = "ExponentPushToken[s2-round-trip-BBBB]"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


@pytest.mark.anyio
async def test_push_device_register_list_revoke_round_trip_realdb():
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from httpx import ASGITransport, AsyncClient

    from app.dependencies.auth import get_verified_org_id
    from app.dependencies.database import get_db
    from app.main import app
    from ee.routers.push_devices import _get_caller_member_id

    engine = create_async_engine(_async_url())
    SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

    # ── 시드: org 1개(org_id FK). member_id 는 FK 없음 → 시드 불요. ──
    async with SessionLocal() as s:
        await s.execute(text("DELETE FROM push_devices WHERE org_id=:o"), {"o": str(ORG)})
        await s.execute(text("DELETE FROM organizations WHERE id=:o"), {"o": str(ORG)})
        await s.execute(
            text("INSERT INTO organizations (id,name,slug,plan) VALUES (:o,'S2 Org','s2-mobile','free')"),
            {"o": str(ORG)},
        )
        await s.commit()

    async def _override_db():
        async with SessionLocal() as sess:
            yield sess
            await sess.commit()

    def _make_caller_override(member_id: uuid.UUID):
        async def _override():
            return member_id
        return _override

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_verified_org_id] = lambda: ORG
    app.dependency_overrides[_get_caller_member_id] = _make_caller_override(MEMBER_X)

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            # 1) 등록(caller=X, token A/ios) → 200, member=X, is_active=True
            r = await client.post("/api/v2/push/devices", json={"expo_push_token": TOKEN_A, "platform": "ios"})
            assert r.status_code == 200, r.text
            dev_a = r.json()
            assert dev_a["member_id"] == str(MEMBER_X)
            assert dev_a["expo_push_token"] == TOKEN_A
            assert dev_a["platform"] == "ios"
            assert dev_a["is_active"] is True
            dev_a_id = dev_a["id"]

            # 2) 같은 토큰 재등록(멱등·app_version 갱신) → 200, 새 행 안 생김
            r = await client.post(
                "/api/v2/push/devices",
                json={"expo_push_token": TOKEN_A, "platform": "ios", "app_version": "1.2.3"},
            )
            assert r.status_code == 200, r.text
            assert r.json()["id"] == dev_a_id  # 동일 행(UNIQUE upsert)
            assert r.json()["app_version"] == "1.2.3"

            # 3) 조회(X) → 정확히 1건(중복 없음)
            r = await client.get("/api/v2/push/devices")
            assert r.status_code == 200, r.text
            assert len(r.json()) == 1
            assert r.json()[0]["expo_push_token"] == TOKEN_A

            # 4) 두 번째 디바이스 등록(token B/android) → 조회 2건
            r = await client.post("/api/v2/push/devices", json={"expo_push_token": TOKEN_B, "platform": "android"})
            assert r.status_code == 200, r.text
            r = await client.get("/api/v2/push/devices")
            assert len(r.json()) == 2

            # 5) 잘못된 토큰 포맷 → 422(방어적 검증)
            r = await client.post("/api/v2/push/devices", json={"expo_push_token": "raw-fcm-xyz", "platform": "ios"})
            assert r.status_code == 422, r.text

            # ── IDOR: caller=Y ──
            app.dependency_overrides[_get_caller_member_id] = _make_caller_override(MEMBER_Y)

            # 6) Y 조회 → 0건(X 디바이스 미노출)
            r = await client.get("/api/v2/push/devices")
            assert r.status_code == 200, r.text
            assert r.json() == []

            # 7) Y 가 X 디바이스 폐기 시도 → 404(소유 아님)
            r = await client.delete(f"/api/v2/push/devices/{dev_a_id}")
            assert r.status_code == 404, r.text

            # ── 다시 X: 폐기 왕복 ──
            app.dependency_overrides[_get_caller_member_id] = _make_caller_override(MEMBER_X)

            # 8) X 가 폐기 → 200
            r = await client.delete(f"/api/v2/push/devices/{dev_a_id}")
            assert r.status_code == 200, r.text
            assert r.json() == {"ok": True}

            # 9) 폐기 후 조회 → token B 만 남음(1건·폐기 반영)
            r = await client.get("/api/v2/push/devices")
            assert len(r.json()) == 1
            assert r.json()[0]["expo_push_token"] == TOKEN_B

            # 10) 이미 폐기한 id 재폐기 → 404(멱등적 부재)
            r = await client.delete(f"/api/v2/push/devices/{dev_a_id}")
            assert r.status_code == 404, r.text
    finally:
        app.dependency_overrides.clear()
        async with SessionLocal() as s:
            await s.execute(text("DELETE FROM organizations WHERE id=:o"), {"o": str(ORG)})  # cascade → devices
            await s.commit()
        await engine.dispose()
