"""a54ddc16: GET /api/v2/attachments/authorize — 첨부 서명 전 SSOT 인가 게이트.

message→ConversationParticipant·story→has_project_access·path 소속 검증·team_member 봐주기 0.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
CONV_ID = uuid.uuid4()
STORY_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
PATH = "chat/2026/06/obj-abc.png"


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client(session):
    from app.main import app
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    async def _db():
        yield session

    async def _auth():
        return ctx

    async def _org():
        return ORG_ID

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), app


def _scalar(v):
    r = MagicMock(); r.scalar_one_or_none.return_value = v; r.scalar.return_value = v
    return r


def _member():
    m = MagicMock(); m.id = MEMBER_ID; return m


@pytest.mark.anyio
async def test_authorize_400_both_resources():
    session = AsyncMock()
    client, app = await _client(session)
    try:
        async with client as c:
            r = await c.get(f"/api/v2/attachments/authorize?path={PATH}&conversation_id={CONV_ID}&story_id={STORY_ID}")
        assert r.status_code == 400
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_authorize_400_neither_resource():
    session = AsyncMock()
    client, app = await _client(session)
    try:
        async with client as c:
            r = await c.get(f"/api/v2/attachments/authorize?path={PATH}")
        assert r.status_code == 400
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_authorize_conversation_participant_and_belongs_200():
    session = AsyncMock()
    # execute: participant select(scalar_one_or_none=id) → belongs(scalar=True)
    session.execute = AsyncMock(side_effect=[_scalar(uuid.uuid4()), _scalar(True)])
    client, app = await _client(session)
    try:
        with patch("app.routers.attachments.resolve_member", new_callable=AsyncMock, return_value=_member()):
            async with client as c:
                r = await c.get(f"/api/v2/attachments/authorize?path={PATH}&conversation_id={CONV_ID}")
        assert r.status_code == 200
        assert r.json()["authorized"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_authorize_conversation_not_participant_403():
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_scalar(None)])  # 참가자 아님
    client, app = await _client(session)
    try:
        with patch("app.routers.attachments.resolve_member", new_callable=AsyncMock, return_value=_member()):
            async with client as c:
                r = await c.get(f"/api/v2/attachments/authorize?path={PATH}&conversation_id={CONV_ID}")
        assert r.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_authorize_conversation_path_not_belongs_403():
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_scalar(uuid.uuid4()), _scalar(False)])  # 참가자지만 path 미소속
    client, app = await _client(session)
    try:
        with patch("app.routers.attachments.resolve_member", new_callable=AsyncMock, return_value=_member()):
            async with client as c:
                r = await c.get(f"/api/v2/attachments/authorize?path={PATH}&conversation_id={CONV_ID}")
        assert r.status_code == 403
    finally:
        app.dependency_overrides.clear()


def _story_row(attachments):
    r = MagicMock()
    r.first.return_value = (PROJECT_ID, attachments)
    return r


@pytest.mark.anyio
async def test_authorize_story_access_and_belongs_200():
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_story_row([{"url": f"https://x/{PATH}"}]))
    client, app = await _client(session)
    try:
        with patch("app.routers.attachments.has_project_access", new_callable=AsyncMock, return_value=True):
            async with client as c:
                r = await c.get(f"/api/v2/attachments/authorize?path={PATH}&story_id={STORY_ID}")
        assert r.status_code == 200
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_authorize_story_no_access_403():
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_story_row([{"url": f"https://x/{PATH}"}]))
    client, app = await _client(session)
    try:
        with patch("app.routers.attachments.has_project_access", new_callable=AsyncMock, return_value=False):
            async with client as c:
                r = await c.get(f"/api/v2/attachments/authorize?path={PATH}&story_id={STORY_ID}")
        assert r.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_authorize_story_path_not_belongs_403():
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_story_row([{"url": "https://x/other-obj.png"}]))
    client, app = await _client(session)
    try:
        with patch("app.routers.attachments.has_project_access", new_callable=AsyncMock, return_value=True):
            async with client as c:
                r = await c.get(f"/api/v2/attachments/authorize?path={PATH}&story_id={STORY_ID}")
        assert r.status_code == 403
    finally:
        app.dependency_overrides.clear()
