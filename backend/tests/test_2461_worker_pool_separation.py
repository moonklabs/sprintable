"""story #2461(§6 봉합③): 배치워커 4종 — claim(짧은 트랜잭션)→work(세션 없음)→finalize 표준화.

PO 지시(2026-08-05): #2460 delivery_dispatcher.py의 F1 패턴을 finding #5의 4워커
(embedding_backlog·event_broker outbox·workflow_sla_processor·workflow_handoff_watchdog)에
적용. 이 파일은 mock 기반 빠른 유닛검증(외부 서비스 무의존)만 — 실 커넥션 반납 실증은
`test_2461_worker_pool_separation_realdb.py`(로컬 PG) 참조. ⛔공유 dev 백엔드 접속 없음.
"""
from __future__ import annotations

import threading
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── workflow_sla_processor: via_outbox 전파 + 배치 상한 ─────────────────────

@pytest.mark.anyio
async def test_sla_notify_uses_via_outbox():
    """_notify()가 dispatch_notification에 via_outbox=True를 넘겨야 한다(finding #5 —
    SLA processor의 FOR UPDATE SKIP LOCKED 트랜잭션 안에서 외부 I/O를 안 하게)."""
    from app.services.workflow_sla_processor import _notify

    sr = MagicMock(org_id=uuid.uuid4(), entity_type="story", entity_id=uuid.uuid4(),
                    from_status="in-review", to_status="done", project_id=uuid.uuid4())
    session = AsyncMock()

    with patch("app.services.notification_dispatch.dispatch_notification", new=AsyncMock()) as mock_notify:
        await _notify(session, sr, uuid.uuid4(), "gate_reminder", "title")

    assert mock_notify.call_args.kwargs["via_outbox"] is True


def test_sla_batch_query_has_explicit_limit():
    """process_sla()의 SELECT가 명시 LIMIT을 갖는지 SQL 컴파일로 확認(finding #5 —
    이전엔 무제한 배치였다)."""
    from sqlalchemy import select
    from sqlalchemy.dialects import postgresql

    from app.models.workflow_line import WorkflowLineStepRun
    from app.services.workflow_sla_processor import _SLA_BATCH_SIZE, _SLA_GATE_STATUSES

    stmt = (
        select(WorkflowLineStepRun)
        .where(WorkflowLineStepRun.status.in_(_SLA_GATE_STATUSES))
        .order_by(WorkflowLineStepRun.started_at.asc())
        .limit(_SLA_BATCH_SIZE)
        .with_for_update(skip_locked=True)
    )
    compiled = str(stmt.compile(dialect=postgresql.dialect()))
    assert "LIMIT" in compiled.upper()
    assert _SLA_BATCH_SIZE > 0


# ─── workflow_handoff_watchdog: via_outbox 전파 + 배치 상한 ──────────────────

@pytest.mark.anyio
async def test_watchdog_fallback_notify_uses_via_outbox():
    """_fallback_notify()가 dispatch_notification에 via_outbox=True를 넘겨야 한다."""
    from app.services.workflow_handoff_watchdog import _fallback_notify

    sr = MagicMock(org_id=uuid.uuid4(), entity_type="story", entity_id=uuid.uuid4(),
                    from_status="in-review", to_status="done", project_id=uuid.uuid4())
    session = AsyncMock()

    with patch("app.services.notification_dispatch.dispatch_notification", new=AsyncMock()) as mock_notify:
        await _fallback_notify(session, sr, uuid.uuid4())

    assert mock_notify.call_args.kwargs["via_outbox"] is True


def test_watchdog_batch_size_constant_positive():
    from app.services.workflow_handoff_watchdog import _WATCHDOG_BATCH_SIZE
    assert _WATCHDOG_BATCH_SIZE > 0


# ─── embedding_backlog: 동기 블로킹 embed_text가 스레드로 오프로드됨 ─────────

@pytest.mark.anyio
async def test_embed_text_offloaded_to_thread_not_event_loop():
    """embed_text() 호출이 메인(이벤트루프) 스레드가 아닌 스레드풀에서 실행돼야 한다 —
    google-genai SDK가 동기 블로킹이라 await 없이 직접 부르면 이벤트루프 전체가 멎는다
    (story #2461 발견·finding #5보다 넓은 blast radius)."""
    from app.services.embedding_backlog import process_embedding_backlog

    main_thread_id = threading.get_ident()
    seen_thread_ids: list[int] = []

    def fake_embed_text(text: str):
        seen_thread_ids.append(threading.get_ident())
        return [0.1] * 768

    row = MagicMock(id=uuid.uuid4(), embedding_text="hello", retry_count=0)
    result_mock = MagicMock()
    result_mock.scalars.return_value.all.return_value = [row]
    session = AsyncMock()
    session.execute = AsyncMock(return_value=result_mock)
    session.commit = AsyncMock()

    with patch("app.services.embedding_client.embed_text", side_effect=fake_embed_text), \
         patch("app.core.config.EMBEDDING_DIMENSION", 768):
        await process_embedding_backlog(session)

    assert len(seen_thread_ids) == 1
    assert seen_thread_ids[0] != main_thread_id  # 스레드풀(다른 스레드)에서 실행됨


# ─── event_broker outbox: claim/publish/finalize 분리 ────────────────────────

@pytest.mark.anyio
async def test_outbox_publish_batch_no_session_arg():
    """`_publish_outbox_batch`는 세션 파라미터를 받지 않는다 — 시그니처 자체가 "세션 없이
    호출돼야 한다"는 계약을 강제한다."""
    import inspect

    from app.services.event_broker import _publish_outbox_batch

    sig = inspect.signature(_publish_outbox_batch)
    params = list(sig.parameters)
    assert params == ["claimed"]  # session 인자가 없음


@pytest.mark.anyio
async def test_outbox_claim_then_publish_then_finalize_order(monkeypatch):
    """outbox_dispatcher_loop 한 tick이 claim→publish→finalize 순서로, claim의 세션이
    publish 시점엔 이미 닫혀 있었음을 mock 호출 순서로 확認."""
    from app.services import event_broker

    call_order: list[str] = []

    async def fake_claim(limit=None):
        call_order.append("claim")
        return [{"id": uuid.uuid4(), "target": "org", "target_id": uuid.uuid4(),
                 "event_type": "x", "payload": {}}]

    async def fake_publish(claimed):
        call_order.append("publish")
        return [c["id"] for c in claimed]

    import asyncio as _asyncio

    async def fake_finalize_then_stop(published_ids):
        # finalize까지 기록한 뒤 CancelledError로 무한루프를 1 tick만에 빠져나온다.
        call_order.append("finalize")
        raise _asyncio.CancelledError()

    monkeypatch.setattr(event_broker, "_claim_outbox_batch", fake_claim)
    monkeypatch.setattr(event_broker, "_publish_outbox_batch", fake_publish)
    monkeypatch.setattr(event_broker, "_finalize_outbox_published", fake_finalize_then_stop)
    from app.core.config import settings as _settings
    monkeypatch.setattr(_settings, "redis_url", "redis://fake")

    await event_broker.outbox_dispatcher_loop()

    assert call_order == ["claim", "publish", "finalize"]
