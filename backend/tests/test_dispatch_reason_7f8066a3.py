"""7f8066a3 (a): DispatchResponse.reason — no_assignee / unresolved_assignee / ok 구분.

FE 가 dispatched:False 를 "담당자 미지정(info 안내)"과 "신원 해소 실패(error)"로 구분해
표시할 수 있도록 BE 가 reason 을 반환. additive·null default 하위호환.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client(mock_session):
    from app.main import app
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    async def _db():
        yield mock_session

    async def _auth():
        return ctx

    async def _org():
        return ORG_ID

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), app


def _body():
    return {"entity_type": "story", "entity_id": str(uuid.uuid4()), "project_id": str(PROJECT_ID)}


@pytest.mark.anyio
async def test_dispatch_no_assignee_reason():
    """assignee 미지정 → dispatched:False, reason='no_assignee' (실패 아님)."""
    session = AsyncMock()
    client, app = await _client(session)
    try:
        with patch("app.routers.dispatch._fetch_entity", new_callable=AsyncMock) as mfetch:
            mfetch.return_value = (None, "Story T", "desc", PROJECT_ID)  # assignee_id=None
            async with client as c:
                resp = await c.post("/api/v2/dispatch", json=_body())
        assert resp.status_code == 200
        data = resp.json()
        assert data["dispatched"] is False
        assert data["reason"] == "no_assignee"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_dispatch_unresolved_assignee_reason():
    """assignee 있으나 신원 해소 실패 → dispatched:False, reason='unresolved_assignee'."""
    session = AsyncMock()
    client, app = await _client(session)
    aid = uuid.uuid4()
    try:
        with patch("app.routers.dispatch._fetch_entity", new_callable=AsyncMock) as mfetch, \
             patch("app.routers.dispatch.resolve_member_identity", new_callable=AsyncMock) as mresolve:
            mfetch.return_value = (aid, "Story T", "desc", PROJECT_ID)
            mresolve.return_value = None  # 해소 실패
            async with client as c:
                resp = await c.post("/api/v2/dispatch", json=_body())
        assert resp.status_code == 200
        data = resp.json()
        assert data["dispatched"] is False
        assert data["reason"] == "unresolved_assignee"
        assert data["assignee_id"] == str(aid)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_dispatch_success_reason_ok():
    """정상 dispatch(human) → dispatched:True, reason='ok' (무회귀)."""
    session = AsyncMock()
    # sender 해소용 execute → scalar_one_or_none = sender_id
    exec_result = MagicMock()
    exec_result.scalar_one_or_none.return_value = uuid.uuid4()
    session.execute = AsyncMock(return_value=exec_result)
    session.add = MagicMock()
    session.flush = AsyncMock()
    session.commit = AsyncMock()
    client, app = await _client(session)
    aid = uuid.uuid4()
    member = MagicMock()
    member.type = "human"
    try:
        with patch("app.routers.dispatch._fetch_entity", new_callable=AsyncMock) as mfetch, \
             patch("app.routers.dispatch.resolve_member_identity", new_callable=AsyncMock) as mresolve, \
             patch("app.routers.dispatch.dispatch_notification", new_callable=AsyncMock) as mnotif, \
             patch("app.services.hypothesis.resolve_dispatch_anchor", new_callable=AsyncMock) as manchor:
            mfetch.return_value = (aid, "Story T", "desc", PROJECT_ID)
            mresolve.return_value = member
            mnotif.return_value = None
            # E1-S6: dispatch가 anchor 해소 쿼리를 추가하므로, reason 검증 전용인 이 테스트는
            # anchor를 None으로 격리한다(이 테스트의 광역 execute mock은 sender용 UUID만 의도).
            manchor.return_value = None
            async with client as c:
                resp = await c.post("/api/v2/dispatch", json=_body())
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["dispatched"] is True
        assert data["reason"] == "ok"
        assert data["assignee_id"] == str(aid)
    finally:
        app.dependency_overrides.clear()
