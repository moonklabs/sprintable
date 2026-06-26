"""a54ddc16: GET /api/v2/attachments/authorize — 첨부 서명 전 SSOT 인가 게이트.

message→ConversationParticipant·story→has_project_access·team_member 봐주기 0.
path 소속 = ① 구조적 스코프(resource id in path) ② canonical object-path 정확 매치(substring 금지·P1).
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
# 업로드 경로 구조: chat/<proj>/<conv>/<file> · story/<proj>/<story>/<file>
CONV_PATH = f"chat/{PROJECT_ID}/{CONV_ID}/u1-abc.png"
STORY_PATH = f"story/{PROJECT_ID}/{STORY_ID}/u1-abc.png"


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


def _story_row(attachments):
    r = MagicMock()
    r.first.return_value = (PROJECT_ID, attachments)
    return r


async def _get(client, qs):
    async with client as c:
        return await c.get(f"/api/v2/attachments/authorize?{qs}")


@pytest.mark.anyio
async def test_authorize_400_both_resources():
    client, app = await _client(AsyncMock())
    try:
        r = await _get(client, f"path={CONV_PATH}&conversation_id={CONV_ID}&story_id={STORY_ID}")
        assert r.status_code == 400
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_authorize_400_path_with_scheme():
    """요청 path 가 bare 가 아니면(스킴 포함) 400 — 임의 URL 주입 차단."""
    client, app = await _client(AsyncMock())
    try:
        r = await _get(client, f"path=https://evil/x&conversation_id={CONV_ID}")
        assert r.status_code == 400
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_authorize_conversation_participant_and_belongs_200():
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_scalar(uuid.uuid4()), _scalar(True)])  # participant, belongs
    client, app = await _client(session)
    try:
        with patch("app.routers.attachments.resolve_member", new_callable=AsyncMock, return_value=_member()):
            r = await _get(client, f"path={CONV_PATH}&conversation_id={CONV_ID}")
        assert r.status_code == 200 and r.json()["authorized"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_authorize_conversation_path_not_scoped_403():
    """구조적 스코프 위반(다른 conv id 의 path)은 권한쿼리 전에 403 — cross-resource 차단."""
    session = AsyncMock()
    session.execute = AsyncMock()  # 호출되면 안 됨
    other_conv = uuid.uuid4()
    client, app = await _client(session)
    try:
        with patch("app.routers.attachments.resolve_member", new_callable=AsyncMock, return_value=_member()):
            r = await _get(client, f"path=chat/{PROJECT_ID}/{other_conv}/u-victim.png&conversation_id={CONV_ID}")
        assert r.status_code == 403
        session.execute.assert_not_awaited()  # 스코프 게이트서 차단
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_authorize_conversation_not_participant_403():
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_scalar(None)])  # 비참가
    client, app = await _client(session)
    try:
        with patch("app.routers.attachments.resolve_member", new_callable=AsyncMock, return_value=_member()):
            r = await _get(client, f"path={CONV_PATH}&conversation_id={CONV_ID}")
        assert r.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_authorize_conversation_belong_exact_miss_403():
    """구조 스코프 통과·참가자지만 stored 와 정확 일치 안 하면 403(substring 아님)."""
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_scalar(uuid.uuid4()), _scalar(False)])
    client, app = await _client(session)
    try:
        with patch("app.routers.attachments.resolve_member", new_callable=AsyncMock, return_value=_member()):
            r = await _get(client, f"path={CONV_PATH}&conversation_id={CONV_ID}")
        assert r.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_authorize_story_access_and_belongs_200():
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_story_row([{"url": STORY_PATH}]))  # bare path 저장
    client, app = await _client(session)
    try:
        with patch("app.routers.attachments.has_project_access", new_callable=AsyncMock, return_value=True):
            r = await _get(client, f"path={STORY_PATH}&story_id={STORY_ID}")
        assert r.status_code == 200
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_authorize_story_legacy_url_exact_match_200():
    """legacy stored(full public URL)도 canonical 추출 후 정확 매치 → 200."""
    session = AsyncMock()
    legacy = f"https://storage.googleapis.com/sprintable-memo-attachments/{STORY_PATH}"
    session.execute = AsyncMock(return_value=_story_row([{"url": legacy}]))
    client, app = await _client(session)
    try:
        with patch("app.routers.attachments.has_project_access", new_callable=AsyncMock, return_value=True):
            r = await _get(client, f"path={STORY_PATH}&story_id={STORY_ID}")
        assert r.status_code == 200
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_authorize_story_substring_attack_403():
    """🔴 P1: 악성 외부 URL 에 victim path 를 substring 으로 심어도 canonical 추출서 None → 403."""
    session = AsyncMock()
    malicious = f"https://malicious.example.com/{STORY_PATH}"  # victim path substring
    session.execute = AsyncMock(return_value=_story_row([{"url": malicious}]))
    client, app = await _client(session)
    try:
        with patch("app.routers.attachments.has_project_access", new_callable=AsyncMock, return_value=True):
            r = await _get(client, f"path={STORY_PATH}&story_id={STORY_ID}")
        assert r.status_code == 403  # substring 매치 안 됨(exact + 우리 버킷 prefix만)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_authorize_story_no_access_403():
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_story_row([{"url": STORY_PATH}]))
    client, app = await _client(session)
    try:
        with patch("app.routers.attachments.has_project_access", new_callable=AsyncMock, return_value=False):
            r = await _get(client, f"path={STORY_PATH}&story_id={STORY_ID}")
        assert r.status_code == 403
    finally:
        app.dependency_overrides.clear()


# E-STORAGE-SSOT S7 — authorize 가 신 org/project namespace 도 인식(legacy 무회귀·신 upload 렌더).
CONV_PATH_S7 = f"org/{ORG_ID}/project/{PROJECT_ID}/chat/{CONV_ID}/u1-abc.png"
STORY_PATH_S7 = f"org/{ORG_ID}/project/{PROJECT_ID}/story/{STORY_ID}/u1-abc.png"


@pytest.mark.anyio
async def test_authorize_conversation_s7_namespace_200():
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_scalar(uuid.uuid4()), _scalar(True)])
    client, app = await _client(session)
    try:
        with patch("app.routers.attachments.resolve_member", new_callable=AsyncMock, return_value=_member()):
            r = await _get(client, f"path={CONV_PATH_S7}&conversation_id={CONV_ID}")
        assert r.status_code == 200 and r.json()["authorized"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_authorize_story_s7_namespace_200():
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_story_row([{"url": STORY_PATH_S7}]))
    client, app = await _client(session)
    try:
        with patch("app.routers.attachments.has_project_access", new_callable=AsyncMock, return_value=True):
            r = await _get(client, f"path={STORY_PATH_S7}&story_id={STORY_ID}")
        assert r.status_code == 200
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_authorize_conversation_s7_wrong_org_403():
    """신 namespace인데 org 불일치(타 org path) → 구조 스코프 거부(403)."""
    import uuid as _u
    bad = f"org/{_u.uuid4()}/project/{PROJECT_ID}/chat/{CONV_ID}/u.png"
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_scalar(uuid.uuid4()), _scalar(True)])
    client, app = await _client(session)
    try:
        with patch("app.routers.attachments.resolve_member", new_callable=AsyncMock, return_value=_member()):
            r = await _get(client, f"path={bad}&conversation_id={CONV_ID}")
        assert r.status_code == 403
    finally:
        app.dependency_overrides.clear()
