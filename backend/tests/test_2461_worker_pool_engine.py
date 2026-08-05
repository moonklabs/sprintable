"""story #2461(§6 봉합③ part2, PO 승인 2026-08-05): 전용 워커풀 엔진 배선 검증.

L2TriggerWorker의 advisory-lock 영구연결(finding #6) + embedding_backlog/
workflow_sla_processor/workflow_handoff_watchdog/event_broker outbox의 claim/finalize
세션(finding #5)을 요청 primary 풀(`app.core.database.engine`)과 완전 분리된
`worker_engine`으로 옮겼다. 이 파일은 그 배선 자체(엔진이 진짜 별개 객체인지·cron 라우터가
정확히 get_worker_db를 쓰는지)를 검증 — 실제 커넥션 독립성 실증은
`test_2461_worker_pool_engine_realdb.py` 참조. ⛔공유 dev 백엔드 접속 없음.
"""
from __future__ import annotations

import pytest


def test_worker_engine_is_distinct_from_request_engine():
    """worker_engine이 request 경로 engine과 별개 객체(= 별개 풀)여야 한다."""
    from app.core.database import engine, worker_engine

    assert worker_engine is not engine
    assert worker_engine.pool is not engine.pool


def test_worker_engine_pool_size_from_settings():
    from app.core.config import settings
    from app.core.database import worker_engine

    assert worker_engine.pool.size() == settings.worker_db_pool_size


def test_worker_session_factory_binds_to_worker_engine():
    from app.core.database import worker_engine, worker_session_factory

    assert worker_session_factory.kw["bind"] is worker_engine


@pytest.mark.anyio
async def test_get_worker_db_yields_session_bound_to_worker_engine():
    from app.core.database import get_worker_db, worker_engine

    gen = get_worker_db()
    session = await gen.__anext__()
    try:
        assert session.bind is worker_engine
    finally:
        await gen.aclose()


def test_cron_batch_endpoints_use_get_worker_db_not_get_db():
    """§6 봉합③ part2가 요구하는 정확한 3개 엔드포인트만 get_worker_db로 전환됐는지 —
    다른 cron 엔드포인트(get_db 나머지 19개)는 무변경이어야 한다(과확장 방지 pin)."""
    import inspect

    from app.core.database import get_db, get_worker_db
    from app.routers import cron

    target_funcs = {
        "workflow_handoff_watchdog": cron.workflow_handoff_watchdog,
        "workflow_sla": cron.workflow_sla,
        "embed_backlog_cron": cron.embed_backlog_cron,
    }
    for name, fn in target_funcs.items():
        sig = inspect.signature(fn)
        default = sig.parameters["session"].default
        # Depends(get_worker_db) — default.dependency가 get_worker_db 함수 그 자체.
        assert default.dependency is get_worker_db, f"{name}가 get_worker_db를 안 씀"
        assert default.dependency is not get_db


def test_l2_lock_uses_worker_engine_not_request_engine():
    """l2_trigger_worker.py의 _ensure_lock 소스에 요청 engine 참조가 남아있지 않은지
    (회귀 방지 — 가장 직접적인 pin)."""
    import inspect

    from app.services.l2_trigger_worker import L2TriggerWorker

    source = inspect.getsource(L2TriggerWorker._ensure_lock)
    assert "worker_engine" in source
    assert "from app.core.database import engine" not in source
