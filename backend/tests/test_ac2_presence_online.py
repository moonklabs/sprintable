"""#2120 AC2: presence_online (online liveness Redis 키) 단위 테스트.

flag off = no-op(무회귀) · flag on = fakeredis 로 mark/get/is_online/clear 왕복 + last_seen_at 주입.
"""
from __future__ import annotations

import datetime
import uuid
from unittest.mock import patch

import pytest

from app.services import presence_online


@pytest.fixture
def _flag_off():
    with patch.object(presence_online.settings, "presence_online_redis_enabled", False):
        yield


@pytest.fixture
def _flag_on_fakeredis():
    """flag on + redis_shared.get_client → fakeredis(공유 서버).

    fakeredis 는 dev-only 테스트 의존이라 CI 이미지에 없을 수 있어 importorskip — 없으면 이 fixture 를
    쓰는 Redis 왕복 테스트만 skip(무해). Redis 경로는 라이브 실측이 결정적으로 커버. flag-off·_override_online
    테스트는 fakeredis 무관하게 항상 실행.
    """
    aioredis = pytest.importorskip("fakeredis.aioredis")

    server = aioredis.FakeServer()
    client = aioredis.FakeRedis(server=server, decode_responses=True)
    with patch.object(presence_online.settings, "presence_online_redis_enabled", True), \
         patch.object(presence_online.settings, "redis_url", "redis://fake"), \
         patch("app.services.redis_shared.get_client", return_value=client):
        yield client


# ── flag off = 무회귀 no-op ────────────────────────────────────────────────────
async def test_flag_off_mark_is_noop(_flag_off):
    await presence_online.mark_online("m1")  # 예외 없이 no-op


async def test_flag_off_get_online_map_empty(_flag_off):
    assert await presence_online.get_online_map(["m1", "m2"]) == {}


async def test_flag_off_is_online_returns_none(_flag_off):
    # None = 호출부가 세션-row 존재 폴백 신호
    assert await presence_online.is_online("m1") is None


# ── flag on = Redis 왕복 ───────────────────────────────────────────────────────
async def test_mark_then_get_and_is_online(_flag_on_fakeredis):
    m = str(uuid.uuid4())
    await presence_online.mark_online(m)
    om = await presence_online.get_online_map([m])
    assert m in om
    # 값은 ISO ts (last_seen_at 주입용)
    datetime.datetime.fromisoformat(om[m])
    assert await presence_online.is_online(m) is True


async def test_clear_online_removes(_flag_on_fakeredis):
    m = str(uuid.uuid4())
    await presence_online.mark_online(m)
    await presence_online.clear_online(m)
    assert await presence_online.get_online_map([m]) == {}
    assert await presence_online.is_online(m) is False


async def test_get_online_map_only_present(_flag_on_fakeredis):
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    await presence_online.mark_online(a)  # b 는 mark 안 함
    om = await presence_online.get_online_map([a, b])
    assert a in om and b not in om


# ── read 주입: _override_online ────────────────────────────────────────────────
def _agent_resp(last_seen_at):
    from app.schemas.team_member import TeamMemberResponse

    _now = datetime.datetime.now(datetime.timezone.utc)
    return TeamMemberResponse(
        id=uuid.uuid4(), project_id=uuid.uuid4(), org_id=uuid.uuid4(),
        type="agent", name="agent", role="member", is_active=True, color="#000000",
        created_at=_now, updated_at=_now,
        last_seen_at=last_seen_at, active_story_id=None,
    )


def test_override_online_injects_last_seen_at():
    from app.routers.team_members import _override_online

    old = datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc)  # 옛날 → offline
    resp = _agent_resp(old)
    assert resp.presence_status == "offline"
    ts = datetime.datetime.now(datetime.timezone.utc).isoformat()
    injected = _override_online(resp, ts)
    assert injected.presence_status == "online"  # 주입된 fresh ts → computed_field online


def test_override_online_none_preserves_db():
    from app.routers.team_members import _override_online

    resp = _agent_resp(datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc))
    assert _override_online(resp, None).presence_status == "offline"  # 폴백=DB 그대로


def test_fakeredis_is_available():
    """가드(silent-skip 문 닫기): fakeredis dev dep 가 빠지면 위 fixture 의 importorskip 이 Redis 왕복
    테스트를 **조용히 skip** 해 CI green인데 커버리지 0(=vacuous)이 되는 문이 열린다. 이 테스트는
    importorskip 아니라 **plain import** 라 dep 이 빠지면 여기서 FAIL → CI red 로 즉시 드러난다."""
    import fakeredis  # noqa: F401
