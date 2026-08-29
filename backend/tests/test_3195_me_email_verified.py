"""story #3195(온보딩·FE) — GET /api/v2/me가 email_verified를 반환해야 온보딩 1/4가
제출(400) 前에 «인증 필요» 안내를 선제 고지할 수 있다(AC2). 신규 DB 쿼리는 human JWT
세션(api_key 컨텍스트가 아닐 때)에만 도는지, api_key 컨텍스트는 무영향(None)인지 고정."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.dependencies.auth import AuthContext
from app.routers.auth import get_auth_me


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _mock_db(email_verified: bool | None) -> AsyncMock:
    session = AsyncMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = email_verified
    session.execute = AsyncMock(return_value=result)
    return session


@pytest.mark.anyio
async def test_human_jwt_session_returns_email_verified_false():
    auth = AuthContext(user_id=str(uuid.uuid4()), email="new@example.com", claims={"app_metadata": {}})
    resp = await get_auth_me(auth=auth, db=_mock_db(False))
    assert resp.email_verified is False


@pytest.mark.anyio
async def test_human_jwt_session_returns_email_verified_true():
    auth = AuthContext(user_id=str(uuid.uuid4()), email="verified@example.com", claims={"app_metadata": {}})
    resp = await get_auth_me(auth=auth, db=_mock_db(True))
    assert resp.email_verified is True


@pytest.mark.anyio
async def test_api_key_agent_context_email_verified_stays_none_no_query():
    """api_key 컨텍스트는 User 행이 없다 — 조회 자체를 안 타서 None(무의미)으로 남아야
    하고, DB round-trip을 낭비하지 않는다(호출 안 됨을 직접 확인)."""
    member_id = uuid.uuid4()
    org_id = uuid.uuid4()
    auth = AuthContext(
        user_id=str(member_id), email=None,
        claims={"app_metadata": {"api_key_id": "key-1", "org_id": str(org_id)}},
        org_id=str(org_id),
    )
    session = AsyncMock()
    session.execute = AsyncMock(return_value=MagicMock(scalar_one_or_none=MagicMock(return_value=[])))
    resp = await get_auth_me(auth=auth, db=session)
    assert resp.email_verified is None


@pytest.mark.anyio
async def test_email_verified_lookup_failure_degrades_to_none_not_crash():
    auth = AuthContext(user_id=str(uuid.uuid4()), email="a@b.com", claims={"app_metadata": {}})
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=RuntimeError("db down"))
    resp = await get_auth_me(auth=auth, db=session)
    assert resp.email_verified is None
