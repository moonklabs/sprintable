"""story #2143(2026-07-23) 근본수정 회귀가드 — agent_stream() 레거시 직접-push 분기가
더는 SSE `id:`에 UUID를 조작해 넣지 않는다.

배경: 이 분기(gateway_seq 없는 payload — events._push_to_agent 호환 경로, presence 등
#2139/#2132가 오늘부로 더 자주 태우는 입구)는 예전에 `id: {uuid.uuid4()}`를 발행했다.
클라(EventSource류)는 그걸 그대로 다음 재연결 Last-Event-ID로 되돌려 보내고, 서버는
`int(uuid문자열)` 파싱 실패를 조용히 삼켜(`except: pass`) header_seq=0으로 폭락 —
결합된 acked_seq도 0(이 경로 이벤트는 애초에 gateway_seq가 없어 ack 대상이 아님)이라
재연결마다 전체 이력을 재전송했다(실측: 13건·44일 전 것까지).

근본수정: gateway_seq가 없는 이벤트는 `id:` 자체를 생략한다(SSE 스펙상 허용) — 존재하지
않는 번호를 지어내면 재개 커서가 거짓 위치를 가리키는 더 나쁜 상태가 된다.
"""
from __future__ import annotations

import asyncio
import uuid
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.dependencies.auth import AuthContext
from app.routers import agent_gateway as ag


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _scalar_result(value):
    r = MagicMock()
    r.scalar_one_or_none.return_value = value
    return r


def _empty_fetchall_result():
    r = MagicMock()
    r.fetchall.return_value = []
    return r


@pytest.mark.anyio
async def test_legacy_direct_push_frame_has_no_id_line(monkeypatch):
    agent_id = uuid.uuid4()
    agent_id_str = str(agent_id)
    org_id = uuid.uuid4()
    tm = MagicMock()
    tm.org_id = org_id

    init_db = AsyncMock()
    init_db.execute = AsyncMock(side_effect=[
        _scalar_result(tm),          # TeamMember lookup
        _scalar_result("free"),     # Organization.plan
        _scalar_result(None),       # AgentEventCursor (acked_seq=0)
    ])

    gen_db = AsyncMock()  # AgentGatewaySession insert block — presence/onboarding calls mocked below
    gen_db.add = MagicMock()
    gen_db.commit = AsyncMock()

    backfill_db = AsyncMock()
    backfill_db.execute = AsyncMock(return_value=_empty_fetchall_result())  # no pre-existing events

    sessions = [init_db, gen_db, backfill_db]
    call_index = {"n": 0}

    def _factory():
        idx = call_index["n"]
        call_index["n"] += 1
        sess = sessions[idx] if idx < len(sessions) else AsyncMock()

        @asynccontextmanager
        async def _ctx():
            yield sess
        return _ctx()

    monkeypatch.setattr(ag, "async_session_factory", _factory)

    # presence/onboarding side-effects — out of scope for this test, no-op them.
    monkeypatch.setattr(
        "app.services.agent_anchor_sync.sync_agent_profile_presence", AsyncMock()
    )
    monkeypatch.setattr(
        "app.services.onboarding_funnel.emit_onboarding_event", AsyncMock()
    )
    monkeypatch.setattr("app.services.presence_online.mark_online", AsyncMock())
    monkeypatch.setattr("app.services.presence_events.emit_presence", AsyncMock())
    monkeypatch.setattr(ag, "_mark_agent_disconnected", AsyncMock())
    monkeypatch.setattr("app.services.sse_lease.acquire", AsyncMock(return_value=None))
    monkeypatch.setattr("app.services.sse_lease.release", AsyncMock())
    monkeypatch.setattr("app.services.sse_lease.refresh", AsyncMock())

    req = MagicMock()
    req.headers = {}
    req.is_disconnected = AsyncMock(return_value=False)
    auth = AuthContext(
        user_id=agent_id_str, email=None,
        claims={"app_metadata": {"api_key_id": "k"}}, org_id=str(org_id),
    )

    resp = await ag.agent_stream(req, auth=auth)

    try:
        # legacy 직접-push 시뮬 — events._push_to_agent이 바로 이 큐에 원시 dict를 넣는다
        # (recipient_seq/__wake__ 없음 — presence/conversation.working이 오늘부로 이 모양).
        queue = next(iter(ag._agent_connections[agent_id_str]))
        queue.put_nowait({"event_type": "presence", "some": "data"})

        chunks: list[str] = []
        async for chunk in resp.body_iterator:
            chunks.append(chunk)
            if "event: presence" in chunk:
                break

        presence_chunk = next(c for c in chunks if "event: presence" in c)
        assert "\nid:" not in presence_chunk, (
            f"레거시 직접-push 프레임에 id: 가 실리면 안 됨(재개 커서 오염) — got: {presence_chunk!r}"
        )
        assert "event: presence" in presence_chunk
        assert "data:" in presence_chunk
    finally:
        await resp.body_iterator.aclose()
        ag._agent_connections.pop(agent_id_str, None)
