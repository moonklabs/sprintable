"""270c87e6: 휴먼 개입 한 벌 — 발화 403 auto-join + per-대화 mute 토글 (BE).

filter(carve-out+mute)의 SQL 정합은 실 DB 스모크에서 검증. 여기선 라우터 분기:
①auto-join 게이트(접근권 휴먼+그룹→자동참여 / 타인 DM·에이전트→403 유지) ②mute 토글 set/clear·비참여 403.
patch 기반(광역 mock 순서의존 회피) — _resolve_member·session.execute를 명시 시퀀스로 제어.
"""
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.services.member_resolver import ResolvedMember

ORG = uuid.uuid4()
CONV = uuid.uuid4()
MEMBER = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _result(scalar=None):
    r = MagicMock()
    r.scalar_one_or_none = MagicMock(return_value=scalar)
    return r


async def _client(session):
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db
    from app.main import app

    ctx = MagicMock(); ctx.user_id = str(MEMBER); ctx.claims = {"app_metadata": {"org_id": str(ORG)}}

    async def _db():
        yield session

    async def _auth():
        return ctx

    async def _org():
        return ORG

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), app


def _member(mtype="human"):
    return ResolvedMember(id=MEMBER, user_id=uuid.uuid4() if mtype == "human" else None,
                          name="t", type=mtype, role="member", org_id=ORG)


def _session(*results):
    s = AsyncMock(); s.execute = AsyncMock(side_effect=list(results))
    s.add = MagicMock(); s.flush = AsyncMock(); s.commit = AsyncMock()
    return s


# ── ① auto-join 게이트 (send_message) ─────────────────────────────────────────

async def test_send_agent_nonparticipant_keeps_403():
    """에이전트 비참여자는 auto-join 안 됨 — 인가 불변(403 유지)."""
    conv = SimpleNamespace(id=CONV, org_id=ORG, project_id=uuid.uuid4(), type="group")
    s = _session(_result(conv), _result(None))  # conv 조회 → participant None
    client, app = await _client(s)
    try:
        with patch("app.routers.conversations._resolve_member", AsyncMock(return_value=_member("agent"))):
            async with client as c:
                resp = await c.post(f"/api/v2/conversations/{CONV}/messages", json={"content": "x"})
        assert resp.status_code == 403
        s.add.assert_not_called()  # auto-join 미발생
    finally:
        app.dependency_overrides.clear()


async def test_send_human_nonparticipant_dm_keeps_403():
    """타인 간 1:1 DM은 비참여 휴먼도 auto-join 예외 — 403 유지(비공개 보호)."""
    conv = SimpleNamespace(id=CONV, org_id=ORG, project_id=uuid.uuid4(), type="dm")
    s = _session(_result(conv), _result(None))
    client, app = await _client(s)
    try:
        with patch("app.routers.conversations._resolve_member", AsyncMock(return_value=_member("human"))):
            async with client as c:
                resp = await c.post(f"/api/v2/conversations/{CONV}/messages", json={"content": "x"})
        assert resp.status_code == 403
        s.add.assert_not_called()
    finally:
        app.dependency_overrides.clear()


# ── ② mute 토글 ───────────────────────────────────────────────────────────────

async def test_mute_sets_muted_at():
    conv = SimpleNamespace(id=CONV, org_id=ORG, project_id=uuid.uuid4(), type="group")
    participant = SimpleNamespace(id=uuid.uuid4(), muted_at=None)
    s = _session(_result(conv), _result(participant))
    client, app = await _client(s)
    try:
        with patch("app.routers.conversations._resolve_member", AsyncMock(return_value=_member("human"))):
            async with client as c:
                resp = await c.patch(f"/api/v2/conversations/{CONV}/mute", json={"muted": True})
        assert resp.status_code == 200 and resp.json()["muted"] is True
        assert participant.muted_at is not None  # mute set
        s.commit.assert_awaited()
    finally:
        app.dependency_overrides.clear()


async def test_unmute_clears_muted_at():
    from datetime import datetime, timezone
    conv = SimpleNamespace(id=CONV, org_id=ORG, project_id=uuid.uuid4(), type="group")
    participant = SimpleNamespace(id=uuid.uuid4(), muted_at=datetime.now(timezone.utc))
    s = _session(_result(conv), _result(participant))
    client, app = await _client(s)
    try:
        with patch("app.routers.conversations._resolve_member", AsyncMock(return_value=_member("human"))):
            async with client as c:
                resp = await c.patch(f"/api/v2/conversations/{CONV}/mute", json={"muted": False})
        assert resp.status_code == 200 and resp.json()["muted"] is False
        assert participant.muted_at is None  # unmute clear
    finally:
        app.dependency_overrides.clear()


async def test_mute_nonparticipant_403():
    conv = SimpleNamespace(id=CONV, org_id=ORG, project_id=uuid.uuid4(), type="group")
    s = _session(_result(conv), _result(None))  # participant 없음
    client, app = await _client(s)
    try:
        with patch("app.routers.conversations._resolve_member", AsyncMock(return_value=_member("human"))):
            async with client as c:
                resp = await c.patch(f"/api/v2/conversations/{CONV}/mute", json={"muted": True})
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()
