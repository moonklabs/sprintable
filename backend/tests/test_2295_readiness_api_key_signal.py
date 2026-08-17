"""story #2295 갭 후속(2026-08-17, PO 판정) — 원 구현이 `pg_pubsub.listen_loop()`에만
readiness를 기대 backplane=redis(현재 dev/prod 실값)에서 listen_loop() 자체가 안 떠 영구
fail-open이던 갭의 회귀가드. 그라운딩으로 찾은 실제 소비처(`_resolve_api_key` — 신규 SSE
연결마다 agent API키 인증이 DB 왕복)를 readiness 신호원에 추가한 것을 검증한다.

핵심 축: DB 연결 자체의 실패(예외)만 UNHEALTHY 신호 — 틀린 키(정상 401, DB는 멀쩡히
응답)는 readiness와 무관해야 한다(틀린 키가 인프라 UNHEALTHY를 만들면 안 됨, PO 명시).
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _reset_readiness_state():
    from app.services import realtime_readiness as rr
    rr._connected = False
    rr._disconnected_since = None
    rr._last_error = None
    yield
    rr._connected = False
    rr._disconnected_since = None
    rr._last_error = None


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_agent_key(s, raw_key: str) -> None:
    """team_members가 VIEW(members ⋈ agent_project_profiles)라 agent_api_keys.team_member_id
    FK를 만족하려면 프로파일까지 함께 심어야 한다 — test_audit_apikey_parity_realdb.py의
    검증된 seed 패턴을 그대로 재사용(새 패턴 발명 0)."""
    from sqlalchemy import text
    from app.core.security import hash_token

    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    member_id = uuid.uuid4()
    key_id = uuid.uuid4()
    await s.execute(text(
        "INSERT INTO organizations (id,name,slug,plan) VALUES (:o,'Org2295',:slug,'free')"
    ), {"o": org_id, "slug": f"org2295-{uuid.uuid4().hex[:8]}"})
    await s.execute(text(
        "INSERT INTO projects (id,org_id,name) VALUES (:p,:o,'P')"
    ), {"p": project_id, "o": org_id})
    await s.execute(text(
        "INSERT INTO members (id,org_id,type,name,is_active) VALUES (:m,:o,'agent','agent2295',true)"
    ), {"m": member_id, "o": org_id})
    await s.execute(text(
        "INSERT INTO agent_project_profiles (id,member_id,project_id,agent_role,fakechat_port,created_at) "
        "VALUES (gen_random_uuid(),:m,:p,'dev',9900,now())"
    ), {"m": member_id, "p": project_id})
    await s.execute(text(
        "INSERT INTO agent_api_keys (id,team_member_id,member_id,key_prefix,key_hash,created_at) "
        "VALUES (:k,:m,:m,'sk_l',:h,now())"
    ), {"k": key_id, "m": member_id, "h": hash_token(raw_key)})
    await s.commit()


@pytest.mark.anyio
async def test_valid_key_marks_connected():
    """실 PG로 유효한 API키를 실제로 조회(성공) — readiness가 connected로 기록된다."""
    from app.dependencies.auth import _resolve_api_key
    from app.services import realtime_readiness as rr

    engine, Session = await _session_factory()
    try:
        raw_key = "sk_live_" + uuid.uuid4().hex
        async with Session() as s:
            await _seed_agent_key(s, raw_key)

        async with Session() as s:
            await _resolve_api_key(raw_key, s)

        healthy, detail = rr.is_ready()
        assert healthy is True
        assert detail["pg_listen"] == "connected"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_wrong_key_does_not_mark_disconnected():
    """PO 명시 조건 — 틀린 키(DB는 멀쩡히 응답, 그냥 매치 행이 없어 401)는 readiness에
    영향 없어야 한다. 틀린 키가 UNHEALTHY를 만들면 인증 실패가 인프라 장애로 오판정된다."""
    from fastapi import HTTPException
    from app.dependencies.auth import _resolve_api_key
    from app.services import realtime_readiness as rr

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await _resolve_api_key("sk_live_" + "0" * 50, s)
            assert exc_info.value.status_code == 401

        # DB 자체는 멀쩡히 응답했으므로(그냥 매치 0건) mark_connected가 불렸어야 한다 —
        # mark_disconnected가 아니라.
        healthy, detail = rr.is_ready()
        assert healthy is True
        assert detail["pg_listen"] == "connected"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_db_connection_failure_marks_disconnected_and_ready_endpoint_reports_unhealthy(monkeypatch):
    """핵심 회귀(PO 조건③) — DB 연결 자체가 실패(예: cloud-sql-proxy 죽음을 흉내낸 예외)하면
    readiness가 disconnected로 기록되고, 유예시간을 넘기면 /api/v2/ready가 실제로 503을
    반환한다. backplane=redis(listen_loop 미기동) 상황에서도 이 소비처만으로 원 인시던트
    (신규 SSE 연결 실패)를 잡는다는 것의 end-to-end 증거."""
    from app.dependencies.auth import _resolve_api_key
    from app.services import realtime_readiness as rr
    from httpx import ASGITransport, AsyncClient

    monkeypatch.setattr(rr, "UNHEALTHY_GRACE_SECONDS", 0.0)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            mock_db = AsyncMock()
            mock_db.execute = AsyncMock(
                side_effect=ConnectionRefusedError("cloud-sql-proxy: bind: address already in use")
            )
            with pytest.raises(ConnectionRefusedError):
                await _resolve_api_key("sk_live_" + "1" * 50, mock_db)

        healthy, detail = rr.is_ready()
        assert healthy is False
        assert detail["pg_listen"] == "disconnected"
        assert "ConnectionRefusedError" in detail["last_error"]

        # end-to-end: /api/v2/ready 자체가 이 상태를 반영해 503을 낸다(GCLB가 실제로 보는 신호).
        from app.main import app
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/v2/ready")
        assert resp.status_code == 503
        assert resp.json()["ready"] is False
    finally:
        await engine.dispose()
