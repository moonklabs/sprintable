"""E-SECURITY SEC-S5(story 278fe427·P0 핫픽스) E2E: 실 get_current_user 경로(override 없음)로
(a)정상 access 토큰 로그인 무회귀 (b)refresh 토큰 Bearer 거부 (c)제거된 멤버의 refresh 토큰도
거부 3종을 실증 — 오르테가 crux 요청("인증 핫픽스는 정상 로그인이 그대로 통과하는 게 생명줄") 대응.

`/api/v2/accounts/resolve`는 get_current_user만 의존(DB 미의존 JWT 경로)이라 override 없이
실 디펜던시 체인을 그대로 태울 수 있는 최소 엔드포인트."""
from __future__ import annotations

import os
import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine, text

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_SYNC = _RAW.replace("postgresql+asyncpg://", "postgresql+psycopg2://").replace(
    "postgresql://", "postgresql+psycopg2://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _client():
    from app.main import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.anyio
async def test_normal_access_token_login_still_works_e2e():
    """(a) 정상 access 토큰 — override 없이 실 get_current_user 경유, 200 무회귀."""
    from app.core.security import create_access_token

    user_id = str(uuid.uuid4())
    token = create_access_token(user_id, email="alice@acme.test", app_metadata={"org_id": str(uuid.uuid4())})
    client = _client()
    try:
        r = await client.post(
            "/api/v2/accounts/resolve",
            json={"refresh_tokens": []},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200, r.text
        assert r.json()["accounts"] == []
    finally:
        await client.aclose()


@pytest.mark.anyio
async def test_refresh_token_as_bearer_rejected_e2e():
    """(b) refresh 토큰을 Bearer로 — 실 경로에서 401(까심 재현 시나리오)."""
    from app.core.security import create_refresh_token

    user_id = str(uuid.uuid4())
    token, _exp = create_refresh_token(user_id, app_metadata={"org_id": str(uuid.uuid4())})
    client = _client()
    try:
        r = await client.post(
            "/api/v2/accounts/resolve",
            json={"refresh_tokens": []},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 401, r.text
    finally:
        await client.aclose()


@pytest.mark.anyio
async def test_removed_member_refresh_token_still_blocked_e2e():
    """(c) 실 DB에 human user+org_member 시드 후 org에서 제거(soft-delete)한 상태에서, 그 멤버가
    (제거 前 발급받은) refresh 토큰을 Bearer로 재사용해도 여전히 401 — SEC-S5 원 취약점의 정확한
    시나리오(제거된 멤버가 org 리소스 계속 접근)가 봉인됐음을 실증."""
    from app.core.security import create_refresh_token

    org_id = uuid.uuid4()
    user_id = uuid.uuid4()
    om_id = uuid.uuid4()
    engine = create_engine(_SYNC)
    try:
        with engine.begin() as conn:
            conn.execute(text(
                f"INSERT INTO organizations (id,name,slug,plan) VALUES "
                f"('{org_id}','SEC-S5 Org','sec-s5-{org_id.hex[:8]}','free')"
            ))
            conn.execute(text(
                "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
                "login_fail_count,totp_enabled,totp_fail_count) "
                f"VALUES ('{user_id}','removed-{user_id.hex[:8]}@test.com','x','Removed',true,true,0,false,0)"
            ))
            conn.execute(text(
                f"INSERT INTO org_members (id,org_id,user_id,role) VALUES "
                f"('{om_id}','{org_id}','{user_id}','member')"
            ))

        # 발급(제거 前) — SEC-S5 취약점의 실제 조건: 이미 손에 쥔 refresh 토큰.
        token, _exp = create_refresh_token(str(user_id), app_metadata={"org_id": str(org_id)})

        # 멤버 제거(soft-delete) — 실 org_members.deleted_at.
        with engine.begin() as conn:
            conn.execute(text(f"UPDATE org_members SET deleted_at = now() WHERE id = '{om_id}'"))

        client = _client()
        try:
            r = await client.post(
                "/api/v2/accounts/resolve",
                json={"refresh_tokens": []},
                headers={"Authorization": f"Bearer {token}"},
            )
            assert r.status_code == 401, r.text
        finally:
            await client.aclose()
    finally:
        with engine.begin() as conn:
            conn.execute(text(f"DELETE FROM org_members WHERE org_id='{org_id}'"))
            conn.execute(text(f"DELETE FROM users WHERE id='{user_id}'"))
            conn.execute(text(f"DELETE FROM organizations WHERE id='{org_id}'"))
        engine.dispose()
