"""story #2381 AC4 — 라이브 양성대조: 고치기 前엔 연결 中인 에이전트가 새 이벤트를 못 받고,
고친 뒤엔 즉시(수로 측정) 받는 것을 실제 `agent_stream()` SSE 제너레이터로 보인다.

AC3(`test_2381_wake_after_commit_race_realdb.py`)는 `assign_recipient_seq()`가 예약한
`wake_agent()`가 commit 後 정확히 한 번 발화되는 것만 검증했다(단위 수준 — 발화 자체).
AC4는 그 발화가 실제로 **연결 中인 `/agent/stream` 소비자에게 새 이벤트로 도달**하는지,
그리고 그게 "몇 초 안에"인지까지를 실제 스트림 제너레이터(`agent_gateway.agent_stream`)로
직접 확認한다 — story #2201의 "ASGI/HTTP 트랜스포트 전부 우회, 라우터 함수 직접 호출 +
body_iterator 직접 순회" 패턴을 그대로 재사용.

- **before 대조군**: `wake_agent`를 no-op으로 치환해 "커밋됐지만 wake가 없다"는 이 스토리의
  근본 증상을 그대로 재현 — 연결 中인 스트림이 짧은 관찰 구간 안에 아무것도 못 받는 것을 보인다
  (실제로는 다음 heartbeat(`_SSE_HEARTBEAT`, 기본 30s)나 재연결까지 무기한 — 여기선 결정론적
  종료를 위해 수 초의 관찰 구간만 사용, "무기한 대기"를 직접 굶기지 않는다).
- **after**: 실제 코드(패치 없음) — `assign_recipient_seq()`의 after-commit 자동 wake가
  이 큐로 실제로 흘러들어와 스트림이 새 이벤트를 즉시 yield하는 것을, 측정한 초 단위 경과로 보인다.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.destructive_schema,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    import app.models  # noqa: F401 — 전 모델 메타데이터 로드(app/models/__init__.py 참조).
    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_agent(Session):
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.team import TeamMember

    org_id, project_id, agent_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    async with Session() as s:
        s.add(Organization(id=org_id, name="t", slug=f"t-{org_id}", plan="free"))
        s.add(Project(id=project_id, org_id=org_id, name="p"))
        await s.flush()
        s.add(TeamMember(
            id=agent_id, org_id=org_id, project_id=project_id, type="agent",
            name="agent", role="member", is_active=True, runtime_type="claude-code",
        ))
        await s.commit()
    return org_id, project_id, agent_id


def _patch_side_effects(monkeypatch):
    """agent_stream() generate()가 스트림 본체(backfill/wake/cursor)와 무관하게 태우는 부수효과
    (presence/onboarding/lease) — 이 테스트의 관측대상이 아니므로 test_2143 선례와 동일하게 no-op."""
    monkeypatch.setattr(
        "app.services.agent_anchor_sync.sync_agent_profile_presence", AsyncMock()
    )
    monkeypatch.setattr(
        "app.services.onboarding_funnel.emit_onboarding_event", AsyncMock()
    )
    monkeypatch.setattr("app.services.presence_online.mark_online", AsyncMock())
    monkeypatch.setattr("app.services.presence_events.emit_presence", AsyncMock())
    monkeypatch.setattr("app.services.sse_lease.acquire", AsyncMock(return_value=None))
    monkeypatch.setattr("app.services.sse_lease.refresh", AsyncMock())
    monkeypatch.setattr("app.services.sse_lease.release", AsyncMock())


class _FakeRequest:
    """test_2128_sse_lifespan_cap.py 선례 — real ASGI Request는 receive 채널 없이 `is_disconnected()`
    호출 시 RuntimeError. 이 스트림 제너레이터의 while-루프가 매 tick 그걸 부르므로 최소 스텁 필요."""
    headers: dict = {}

    async def is_disconnected(self) -> bool:
        return False


async def _open_stream(ag, Session, agent_id: uuid.UUID, org_id: uuid.UUID):
    from app.dependencies.auth import AuthContext

    auth = AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": "test-key", "org_id": str(org_id)}},
    )
    resp = await ag.agent_stream(_FakeRequest(), auth=auth)
    assert resp.status_code == 200
    return resp


async def _dispatch_agent_event(Session, *, org_id: uuid.UUID, project_id: uuid.UUID, agent_id: uuid.UUID) -> None:
    """실 프로덕션 경로 그대로: Event 생성 → assign_recipient_seq (agent 가시성의 유일한 관문,
    #2375) → commit. 이 함수 자체는 wake_agent()를 부르지 않는다 — event_seq.py의 after-commit
    자동예약이 유일한 발화 경로(이 테스트가 증명하려는 바로 그것)."""
    from app.models.event import Event
    from app.services.event_seq import assign_recipient_seq

    async with Session() as s:
        event = Event(
            project_id=project_id, org_id=org_id, event_type="dispatched",
            recipient_id=agent_id, recipient_type="agent",
            payload={"content": "AC4 라이브 배달 검증"}, status="pending",
        )
        s.add(event)
        await s.flush()
        await assign_recipient_seq(s, event)
        await s.commit()


@pytest.mark.anyio
async def test_before_no_wake_connected_agent_gets_nothing_in_short_window(monkeypatch):
    """AC4 before-대조군: wake_agent()가 발화되지 않으면(이 스토리의 근본 증상을 직접 재현),
    연결 中인 스트림은 커밋된 새 이벤트를 짧은 관찰 구간(1.5s) 안에 전혀 못 받는다 — 다음
    heartbeat(기본 30s)나 재연결(backfill)까지 발견 경로가 없다는 것이 이 스토리의 본체다."""
    import app.routers.agent_gateway as ag

    _patch_side_effects(monkeypatch)
    # ⛔근본 증상 재현: wake_agent를 no-op으로 — "commit 됐지만 아무도 안 깨운다".
    monkeypatch.setattr(ag, "wake_agent", lambda *a, **kw: None)

    engine, Session = await _session_factory()
    try:
        org_id, project_id, agent_id = await _seed_agent(Session)
        monkeypatch.setattr(ag, "async_session_factory", lambda: Session())

        resp = await _open_stream(ag, Session, agent_id, org_id)
        agen = resp.body_iterator
        try:
            first = await agen.__anext__()
            assert "event: heartbeat" in first

            # ⭐backfill(빈 결과)을 지나 queue.get() 블로킹까지 제너레이터를 먼저 진행시켜야
            # "연결 中(이미 backfill 다 돈 뒤)에 새 이벤트가 온다"는 이 AC의 전제가 성립한다 —
            # 이 진행 전에 dispatch하면 backfill이 그걸 주워 담아 "wake 없이도 왔다"는 거짓
            # 양성이 된다(이 테스트 작성 중 실제로 재현·수정한 함정).
            next_frame_task = asyncio.create_task(agen.__anext__())
            await asyncio.sleep(0.05)

            await _dispatch_agent_event(Session, org_id=org_id, project_id=project_id, agent_id=agent_id)

            # ⛔`asyncio.wait_for`는 안 쓴다 — 타임아웃 시 task를 취소하는데, 그 취소가 스트림의
            # `except (asyncio.CancelledError, GeneratorExit): pass`에 그대로 삼켜져 제너레이터가
            # "정상 종료"해 버린다(`StopAsyncIteration`) — "안 왔다"가 아니라 "스트림이 끊겼다"를
            # 관측하는 거짓 시그널이 된다(이 테스트 작성 중 직접 재현). `asyncio.wait`는 타임아웃
            # 시 task를 취소하지 않으므로 "아직 pending"이라는 진짜 신호를 그대로 남긴다.
            done, pending = await asyncio.wait({next_frame_task}, timeout=1.5)
            assert next_frame_task in pending, (
                f"wake 없이도 새 이벤트가 도달함(레이스/우회 경로 존재) — 받은 프레임: "
                f"{next_frame_task.result() if next_frame_task in done else None!r}"
            )
            next_frame_task.cancel()
            with pytest.raises((asyncio.CancelledError, StopAsyncIteration)):
                await next_frame_task
        finally:
            await agen.aclose()
    finally:
        ag._agent_connections.pop(str(agent_id), None)
        await engine.dispose()
        # test_2128_sse_lifespan_cap.py 선례: generate()가 module-singleton shutdown_event를
        # 이 테스트의 이벤트루프에 바인딩시킨다 — 안 풀면 다음 테스트(다른 루프)가 cross-loop
        # RuntimeError.
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()


@pytest.mark.anyio
async def test_after_wake_connected_agent_gets_new_event_immediately(monkeypatch):
    """AC4 after: 패치 없는 실제 코드 경로 — assign_recipient_seq()의 after-commit 자동 wake가
    실제로 이 스트림의 큐까지 흘러들어와, 연결 中인 에이전트가 새 이벤트를 즉시(수로 측정)
    받는다. AC4가 요구하는 "몇 초 안에"의 실측값이 assert 메시지에 그대로 남는다."""
    import app.routers.agent_gateway as ag

    _patch_side_effects(monkeypatch)
    # wake_agent는 손대지 않는다 — 이게 바로 이 스토리가 고친 실제 경로.

    engine, Session = await _session_factory()
    try:
        org_id, project_id, agent_id = await _seed_agent(Session)
        monkeypatch.setattr(ag, "async_session_factory", lambda: Session())

        resp = await _open_stream(ag, Session, agent_id, org_id)
        agen = resp.body_iterator
        try:
            first = await agen.__anext__()
            assert "event: heartbeat" in first

            next_frame_task = asyncio.create_task(agen.__anext__())
            # 스트림이 이미 queue.get()에서 블로킹 中인 것을 보장(다음 tick 양보) — 그 뒤에
            # dispatch해야 "연결 中에 새 이벤트가 온다"는 이 AC의 전제가 실제로 성립한다.
            await asyncio.sleep(0.05)

            t_commit_start = time.monotonic()
            await _dispatch_agent_event(Session, org_id=org_id, project_id=project_id, agent_id=agent_id)

            chunk = await asyncio.wait_for(next_frame_task, timeout=5.0)
            elapsed = time.monotonic() - t_commit_start

            assert "event: dispatched" in chunk, f"기대한 dispatched 프레임이 아님: {chunk!r}"
            data_line = next(line for line in chunk.splitlines() if line.startswith("data: "))
            payload = json.loads(data_line[len("data: "):])
            assert payload["content"] == "AC4 라이브 배달 검증"
            assert payload["is_backfill"] is False, "wake 경로가 아니라 backfill로 온 것처럼 보임"
            assert elapsed < 2.0, (
                f"AC4: commit 後 새 이벤트가 연결 中인 스트림에 도달하는 데 {elapsed:.4f}초 걸림"
                f" — 즉시(<2s)가 아님"
            )
            print(f"\n[AC4 실측] commit → 연결 中인 스트림 수신까지: {elapsed:.4f}초")
        finally:
            await agen.aclose()
    finally:
        ag._agent_connections.pop(str(agent_id), None)
        await engine.dispose()
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()
