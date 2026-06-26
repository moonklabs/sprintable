"""멀티계정 prod 회귀(e3a1ff46) real-DB: /api/v2/accounts/resolve + /api/v2/auth/switch-account.

라이브 회귀=두 endpoint BE 미구현(404)→switcher 전 계정 "Unknown"·switch 무동작. resolve 메타·
switch rotation 왕복을 real-DB 로 실증. DB env 없으면 skip(CI alembic-fresh 잡서 실행).
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import timedelta

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine, text

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)
_SYNC = _RAW.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
    "postgresql://", "postgresql+psycopg2://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("ac000000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("ac000000-0000-0000-0000-0000000000c1")
USER = uuid.UUID("ac000000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("ac000000-0000-0000-0000-0000000000b1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _seed_sync():
    """org/project/user + stored refresh token 시드(sync). 반환=rt(원문)."""
    from app.core.security import create_refresh_token, hash_token

    rt, exp = create_refresh_token(str(USER))
    engine = create_engine(_SYNC)
    try:
        with engine.begin() as conn:
            for sql in [
                f"DELETE FROM project_access WHERE project_id='{PROJ}'",
                f"DELETE FROM org_members WHERE org_id='{ORG}'",
                f"DELETE FROM refresh_tokens WHERE user_id='{USER}'",
                f"DELETE FROM projects WHERE id='{PROJ}'",
                f"DELETE FROM users WHERE id='{USER}'",
                f"DELETE FROM organizations WHERE id='{ORG}'",
                f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','Acme','acme','free')",
                f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ}','{ORG}','P')",
                "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
                "login_fail_count,totp_enabled,totp_fail_count,last_org_id,last_project_id) "
                f"VALUES ('{USER}','alice@acme.test','x','Alice',true,true,0,false,0,'{ORG}','{PROJ}')",
                # 멤버십: switch 의 project 컨텍스트 resolve 가 PROJ 를 유지하도록(accessible).
                f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','member')",
                f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
                f"VALUES (gen_random_uuid(),'{PROJ}','{OM}','granted')",
            ]:
                conn.execute(text(sql))
            conn.execute(
                text(
                    "INSERT INTO refresh_tokens (id,user_id,token_hash,expires_at) "
                    "VALUES (gen_random_uuid(), :uid, :h, :exp)"
                ),
                {"uid": str(USER), "h": hash_token(rt), "exp": exp},
            )
        return rt
    finally:
        engine.dispose()


def _cleanup_sync():
    engine = create_engine(_SYNC)
    try:
        with engine.begin() as conn:
            for sql in [
                f"DELETE FROM project_access WHERE project_id='{PROJ}'",
                f"DELETE FROM org_members WHERE org_id='{ORG}'",
                f"DELETE FROM refresh_tokens WHERE user_id='{USER}'",
                f"DELETE FROM projects WHERE id='{PROJ}'",
                f"DELETE FROM users WHERE id='{USER}'",
                f"DELETE FROM organizations WHERE id='{ORG}'",
            ]:
                conn.execute(text(sql))
    finally:
        engine.dispose()


async def _client():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.database import get_db
    from app.main import app

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)

    async def _override_db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_current_user] = lambda: AuthContext(
        user_id=str(USER), email="alice@acme.test", claims={}, org_id=str(ORG)
    )
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    return client, engine, app


@pytest.mark.anyio
async def test_resolve_returns_account_metadata():
    rt = _seed_sync()
    client, engine, app = await _client()
    try:
        r = await client.post(
            "/api/v2/accounts/resolve",
            json={"refresh_tokens": [rt, "garbage.token.value"]},
            headers={"Authorization": "Bearer x"},
        )
        assert r.status_code == 200, r.text
        accounts = r.json()["accounts"]
        assert len(accounts) == 1  # garbage(우리 서명 아님) skip
        a = accounts[0]
        assert a["account_id"] == str(USER)
        assert a["name"] == "Alice" and a["email"] == "alice@acme.test"
        assert a["org_name"] == "Acme" and a["status"] == "active"
    finally:
        app.dependency_overrides.clear()
        await client.aclose()
        await engine.dispose()
        _cleanup_sync()


@pytest.mark.anyio
async def test_switch_account_rotates_and_returns_project():
    rt = _seed_sync()
    client, engine, app = await _client()
    try:
        r = await client.post("/api/v2/auth/switch-account", json={"refresh_token": rt})
        assert r.status_code == 200, r.text
        body = r.json()
        data = body.get("data", body)
        assert data["access_token"] and data["refresh_token"]
        assert data["project_id"] == str(PROJ)
        assert data["refresh_token"] != rt  # rotation

        # 기존 RT revoke 확인(single-use)
        from app.core.security import hash_token
        chk = create_engine(_SYNC)
        try:
            with chk.begin() as conn:
                revoked = conn.execute(text(
                    "SELECT revoked_at FROM refresh_tokens WHERE token_hash=:h"
                ), {"h": hash_token(rt)}).scalar_one()
            assert revoked is not None
        finally:
            chk.dispose()

        # revoked RT 재switch → 401
        r2 = await client.post("/api/v2/auth/switch-account", json={"refresh_token": rt})
        assert r2.status_code == 401
    finally:
        app.dependency_overrides.clear()
        await client.aclose()
        await engine.dispose()
        _cleanup_sync()


@pytest.mark.anyio
async def test_resolve_expired_and_unstored_rt_no_pii():
    """만료 RT·미저장(유효서명·DB無) RT → status=expired·PII 0(까심: stale RT 만으로 PII 노출 차단)."""
    from app.core.security import create_refresh_token, hash_token

    _seed_sync()
    expired_rt, exp = create_refresh_token(str(USER), expires_delta=timedelta(seconds=-10))
    eng = create_engine(_SYNC)
    try:
        with eng.begin() as conn:
            conn.execute(
                text("INSERT INTO refresh_tokens (id,user_id,token_hash,expires_at) "
                     "VALUES (gen_random_uuid(), :u, :h, :e)"),
                {"u": str(USER), "h": hash_token(expired_rt), "e": exp},
            )
    finally:
        eng.dispose()
    unstored_rt, _ = create_refresh_token(str(USER))  # 저장 안 함

    client, engine, app = await _client()
    try:
        for tok in (expired_rt, unstored_rt):
            r = await client.post("/api/v2/accounts/resolve", json={"refresh_tokens": [tok]},
                                  headers={"Authorization": "Bearer x"})
            assert r.status_code == 200, r.text
            a = r.json()["accounts"][0]
            assert a["account_id"] == str(USER) and a["status"] == "expired"
            # exclude_none(minor#1): 비활성은 PII 키 자체가 응답에 없음(null 키 잔존 X)
            assert "name" not in a and "email" not in a
            assert "org_name" not in a and "avatar_url" not in a
    finally:
        app.dependency_overrides.clear()
        await client.aclose()
        await engine.dispose()
        _cleanup_sync()


@pytest.mark.anyio
async def test_forged_token_skipped_and_switch_401():
    """위조(서명 불일치) 토큰: resolve skip(0건)·switch 401(우리 서명만 통과)."""
    _seed_sync()
    forged = "forged.invalid.token"
    client, engine, app = await _client()
    try:
        r = await client.post("/api/v2/accounts/resolve", json={"refresh_tokens": [forged]},
                              headers={"Authorization": "Bearer x"})
        assert r.status_code == 200 and r.json()["accounts"] == []
        r2 = await client.post("/api/v2/auth/switch-account", json={"refresh_token": forged})
        assert r2.status_code == 401
    finally:
        app.dependency_overrides.clear()
        await client.aclose()
        await engine.dispose()
        _cleanup_sync()


@pytest.mark.anyio
async def test_switch_concurrent_double_spend_single_success():
    """동시 2요청 동일 RT → 원자 rotation 으로 정확히 1건 성공·1건 401(까심 TOCTOU double-spend)."""
    rt = _seed_sync()
    client, engine, app = await _client()
    try:
        results = await asyncio.gather(
            client.post("/api/v2/auth/switch-account", json={"refresh_token": rt}),
            client.post("/api/v2/auth/switch-account", json={"refresh_token": rt}),
        )
        codes = sorted(r.status_code for r in results)
        assert codes == [200, 401], [r.status_code for r in results]
    finally:
        app.dependency_overrides.clear()
        await client.aclose()
        await engine.dispose()
        _cleanup_sync()


@pytest.mark.anyio
async def test_resolve_same_sub_active_priority():
    """동일 sub 의 만료 토큰이 먼저 와도 active 계정은 active 로 병합(까심 minor#2·switcher 회귀 차단)."""
    from app.core.security import create_refresh_token, hash_token

    active_rt = _seed_sync()  # USER 의 유효 저장 토큰
    expired_rt, exp = create_refresh_token(str(USER), expires_delta=timedelta(seconds=-10))
    eng = create_engine(_SYNC)
    try:
        with eng.begin() as conn:
            conn.execute(
                text("INSERT INTO refresh_tokens (id,user_id,token_hash,expires_at) "
                     "VALUES (gen_random_uuid(), :u, :h, :e)"),
                {"u": str(USER), "h": hash_token(expired_rt), "e": exp},
            )
    finally:
        eng.dispose()

    client, engine, app = await _client()
    try:
        # 만료 토큰을 **먼저** 둔다 — 순서 의존 dedupe면 expired 로 잘못 표시될 케이스.
        r = await client.post("/api/v2/accounts/resolve",
                              json={"refresh_tokens": [expired_rt, active_rt]},
                              headers={"Authorization": "Bearer x"})
        assert r.status_code == 200, r.text
        accounts = r.json()["accounts"]
        assert len(accounts) == 1  # 동일 sub → 1 계정
        a = accounts[0]
        assert a["account_id"] == str(USER)
        assert a["status"] == "active"  # 만료가 먼저여도 active 우선
        assert a["name"] == "Alice"     # active 라 PII 정상
    finally:
        app.dependency_overrides.clear()
        await client.aclose()
        await engine.dispose()
        _cleanup_sync()
