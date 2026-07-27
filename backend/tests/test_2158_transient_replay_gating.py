"""#2158: `_push_to_agent`의 B계열(무 DB event_id) 재생 버퍼 기록 게이팅 + 재연결 replay 배선 검증.

핵심 불변식(AC2 — 이중배달 0, 구조로):
  - payload에 event_id가 있으면(A계열, DB backfill 대상) 재생 버퍼에 절대 기록하지 않는다.
  - payload에 event_id가 없으면(B계열) 기록한다 — 단 원발행(`_from_listener=False`)에서만,
    한 번(멀티인스턴스 리스너 콜백마다 중복 기록 방지).
"""
from __future__ import annotations

import asyncio
import inspect
import uuid
from unittest.mock import patch

import pytest

from app.routers import events as events_mod
from app.services import sse_transient_replay


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def _replay_fakeredis():
    aioredis = pytest.importorskip("fakeredis.aioredis")
    server = aioredis.FakeServer()
    client = aioredis.FakeRedis(server=server, decode_responses=True)
    with patch.object(sse_transient_replay.settings, "sse_transient_replay_enabled", True), \
         patch.object(sse_transient_replay.settings, "redis_url", "redis://fake"), \
         patch("app.services.redis_shared.get_client", return_value=client):
        yield client


# ── 게이팅: event_id 유무 ────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_push_without_event_id_records_to_replay_buffer(_replay_fakeredis):
    member_id = str(uuid.uuid4())
    events_mod._push_to_agent(member_id, {"event_type": "conversation.read", "unread_count": 1})
    await asyncio.sleep(0)  # fire_and_forget 예약분 flush

    out = await sse_transient_replay.replay(member_id, since=None)
    assert len(out) == 1
    assert out[0]["event_type"] == "conversation.read"


@pytest.mark.anyio
async def test_push_with_event_id_does_not_record(_replay_fakeredis):
    """A계열(DB Event row 있음) — DB backfill이 이미 커버 → 재생 버퍼 이중기록 금지."""
    member_id = str(uuid.uuid4())
    events_mod._push_to_agent(
        member_id, {"event_type": "conversation.message_created", "event_id": str(uuid.uuid4())}
    )
    await asyncio.sleep(0)

    assert await sse_transient_replay.replay(member_id, since=None) == []


@pytest.mark.anyio
async def test_listener_triggered_push_never_records(_replay_fakeredis):
    """_from_listener=True(크로스인스턴스 리스너 콜백)는 원발행이 아니므로 기록 안 함
    — 멀티인스턴스에서 인스턴스 수만큼 중복 기록되는 것을 막는다."""
    member_id = str(uuid.uuid4())
    events_mod._push_to_agent(
        member_id, {"event_type": "conversation.read"}, _from_listener=True
    )
    await asyncio.sleep(0)

    assert await sse_transient_replay.replay(member_id, since=None) == []


@pytest.mark.anyio
async def test_push_records_even_when_no_local_queue(_replay_fakeredis):
    """로컬 큐가 없어(재연결 공백) pushed=False여도 원발행이면 버퍼엔 기록된다 —
    event_broker.publish와 동일 무조건 호출 지점(기존 컨벤션과 정합)."""
    member_id = str(uuid.uuid4())  # 연결된 큐 없음
    pushed = events_mod._push_to_agent(member_id, {"event_type": "presence"})
    await asyncio.sleep(0)

    assert pushed is False
    assert len(await sse_transient_replay.replay(member_id, since=None)) == 1


# ── generate() 배선 — 구조 검증(전체 async generator 구동은 알려진 hang 이슈로 회피,
#    test_s6_1_sse_backfill.py의 소스 검증 관례를 따른다) ───────────────────────────
def test_generate_source_calls_replay_after_db_backfill():
    source = inspect.getsource(events_mod.agent_event_stream)
    assert "sse_transient_replay.replay(member_id_str" in source
    # DB backfill(commit) 이후, 라이브 큐 리슨 시작 이전에 위치
    db_backfill_pos = source.index("await db.commit()")
    replay_pos = source.index("sse_transient_replay.replay(member_id_str")
    listen_pos = source.index("# 신규 이벤트 리슨")
    assert db_backfill_pos < replay_pos < listen_pos


def test_generate_replay_marks_is_backfill_true():
    source = inspect.getsource(events_mod.agent_event_stream)
    assert "'is_backfill': True" in source.split("sse_transient_replay.replay(member_id_str")[1][:600]


def test_generate_replay_reuses_ref_cutoff():
    """신규 클라 계약 없이 기존 _ref(last_event_id/since_timestamp 파생) 커서를 그대로 재사용."""
    source = inspect.getsource(events_mod.agent_event_stream)
    assert "_replay_cutoff = _ref.timestamp() if _ref is not None else None" in source


# ── push_to_agent 자체 게이팅 소스 고정(회귀 방지) ───────────────────────────────
def test_push_to_agent_source_gates_on_event_id_and_not_from_listener():
    source = inspect.getsource(events_mod._push_to_agent)
    assert "is_db_backed = bool(payload.get(\"event_id\"))" in source
    assert "if not is_db_backed:" in source
    # 게이팅이 `if not _from_listener:` 블록 안쪽(원발행 1회만)인지 — 들여쓰기로 확인
    outer_idx = source.index("if not _from_listener:")
    inner_idx = source.rindex("if not is_db_backed:")  # record() 호출 게이트(두 번째 등장)
    assert outer_idx < inner_idx


# ── agent_inbox.py 부수 정정: event_id 누락이 재생 버퍼 이중기록을 만들지 않도록 ──
def test_agent_inbox_push_includes_event_id():
    from app.routers import agent_inbox

    source = inspect.getsource(agent_inbox.receive_inbox_webhook)
    assert '"event_id": str(event.id)' in source


# ── ⭐오르테가군 PR 전 리뷰 ①: 라이브 배달·재생 배달이 같은 id를 공유(이중배달 0) ──────
@pytest.mark.anyio
async def test_transient_id_assigned_once_and_shared_with_queue(_replay_fakeredis):
    """B계열 push 시 발행 시점에 `_sse_transient_id`가 한 번 부여되고, 로컬 큐로 전달되는
    payload와 재생 버퍼에 기록되는 payload가 **같은** id를 갖는다."""
    member_id = str(uuid.uuid4())
    q: asyncio.Queue = asyncio.Queue(maxsize=10)
    events_mod._agent_connections[member_id].add(q)
    try:
        events_mod._push_to_agent(member_id, {"event_type": "conversation.read"})
        await asyncio.sleep(0)

        queued = q.get_nowait()
        buffered = (await sse_transient_replay.replay(member_id, since=None))[0]
        assert queued["_sse_transient_id"] == buffered["_sse_transient_id"]
        assert queued["_sse_transient_id"]  # 비어있지 않음
    finally:
        events_mod._agent_connections[member_id].discard(q)
        events_mod._agent_connections.pop(member_id, None)


@pytest.mark.anyio
async def test_listener_triggered_push_preserves_incoming_transient_id(_replay_fakeredis):
    """크로스인스턴스 리스너 콜백(`_from_listener=True`)은 원발행 인스턴스가 이미 실어 보낸
    `_sse_transient_id`를 재할당하지 않고 그대로 큐에 넣는다 — 재할당하면 인스턴스마다
    다른 id가 생겨 dedup이 무의미해진다."""
    member_id = str(uuid.uuid4())
    q: asyncio.Queue = asyncio.Queue(maxsize=10)
    events_mod._agent_connections[member_id].add(q)
    try:
        events_mod._push_to_agent(
            member_id, {"event_type": "conversation.read", "_sse_transient_id": "origin-id-123"},
            _from_listener=True,
        )
        queued = q.get_nowait()
        assert queued["_sse_transient_id"] == "origin-id-123"
    finally:
        events_mod._agent_connections[member_id].discard(q)
        events_mod._agent_connections.pop(member_id, None)


def test_live_loop_reuses_sse_transient_id_for_id_field():
    """generate() 라이브 루프가 eid 없을 때 매번 새 uuid4 대신 `_sse_transient_id`를 우선
    사용 — 재생 버퍼와 동일 id 공유의 짝(반대편이 events.py에도 있어야 실제로 성립)."""
    source = inspect.getsource(events_mod.agent_event_stream)
    assert '_transient_id = event_data.pop("_sse_transient_id", None)' in source
    assert "_live_id = eid or _transient_id or str(uuid.uuid4())" in source


def test_replay_yield_reuses_stored_transient_id_not_fresh_uuid():
    source = inspect.getsource(events_mod.agent_event_stream)
    replay_block = source.split("sse_transient_replay.replay(member_id_str")[1][:600]
    assert '_r_payload.pop("_sse_transient_id", None)' in replay_block
