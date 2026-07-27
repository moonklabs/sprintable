"""#2176 AC1: emit_story_status_changed의 서버측 구간 계측(요청 수신→emit 착수→fan-out 완료).

미르코 실측(2026-07-24) — 칸반 상태변경이 액터 호출부터 화면 도착까지 10초(전달 4.7초+렌더
5.0초)였는데 "액터 호출 시작"이 MCP 발신 시각이라 BE 처리·발행이 섞여 있어 #2158의 순수 SSE
전송 400ms대와 기준선이 다르다는 caveat — 쪼개지 않고 처방부터 고르면 엉뚱한 데를 판다. 이
계측은 순수 logging(DB/Redis 호출 0)이라 #2123이 비운 hot-path에 부하를 다시 안 얹는다.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services import story_status_events as sse_mod
from app.services.story_status_events import emit_story_status_changed


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _story(**overrides):
    now = datetime(2026, 6, 10, 12, 0, 0, tzinfo=timezone.utc)
    base = dict(
        id=uuid.uuid4(), project_id=uuid.uuid4(), epic_id=None,
        title="t", status="in-progress", priority="medium", assignee_id=None,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


class _TimingCapture(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records: list[dict] = []

    def emit(self, record):
        if "emit timing" in record.getMessage():
            self.records.append(getattr(record, "structured", None))


@pytest.fixture
def _capture():
    h = _TimingCapture()
    logger = logging.getLogger("app.services.story_status_events")
    logger.addHandler(h)
    logger.setLevel(logging.INFO)
    yield h
    logger.removeHandler(h)


def _mock_db():
    db = AsyncMock()
    db.execute = AsyncMock(return_value=MagicMock())
    db.add = MagicMock()
    db.flush = AsyncMock()
    return db


@pytest.mark.anyio
async def test_timing_log_includes_all_ac1_segments_when_request_received_at_given(monkeypatch, _capture):
    monkeypatch.setattr(sse_mod, "project_accessible_member_ids", AsyncMock(return_value=set()), raising=False)
    monkeypatch.setattr("app.services.project_auth.project_accessible_member_ids", AsyncMock(return_value=set()))
    monkeypatch.setattr("app.services.webhook_dispatch.fire_webhooks", AsyncMock())
    monkeypatch.setattr("app.services.workflow_pipeline.process_event", AsyncMock())
    monkeypatch.setattr("app.services.trust_pipeline.emit_on_story_status_change", AsyncMock())

    story = _story(status="in-progress")
    db = _mock_db()
    import time as _time
    t0 = _time.time()

    await emit_story_status_changed(db, uuid.uuid4(), story, "todo", request_received_at=t0)

    assert len(_capture.records) == 1
    rec = _capture.records[0]
    assert rec["story_id"] == str(story.id)
    assert rec["old_status"] == "todo"
    assert rec["new_status"] == "in-progress"
    assert rec["request_received_at"] == t0
    assert rec["emit_started_at"] >= t0
    assert rec["emit_completed_at"] >= rec["emit_started_at"]
    assert rec["server_processing_ms"] is not None and rec["server_processing_ms"] >= 0
    assert rec["emit_fanout_ms"] is not None and rec["emit_fanout_ms"] >= 0
    assert rec["recipient_count"] == 0


@pytest.mark.anyio
async def test_timing_log_server_processing_ms_none_without_request_received_at(monkeypatch, _capture):
    """advance_story_to_done류 콜사이트는 request_received_at을 안 넘긴다 — 계약 확장 없이
    그 구간만 None으로 빠지고 나머지(emit_fanout_ms)는 여전히 채워져야."""
    monkeypatch.setattr("app.services.project_auth.project_accessible_member_ids", AsyncMock(return_value=set()))
    monkeypatch.setattr("app.services.webhook_dispatch.fire_webhooks", AsyncMock())
    monkeypatch.setattr("app.services.workflow_pipeline.process_event", AsyncMock())
    monkeypatch.setattr("app.services.trust_pipeline.emit_on_story_status_change", AsyncMock())

    story = _story(status="done")
    db = _mock_db()

    await emit_story_status_changed(db, uuid.uuid4(), story, "in-progress")

    assert len(_capture.records) == 1
    rec = _capture.records[0]
    assert rec["request_received_at"] is None
    assert rec["server_processing_ms"] is None
    assert rec["emit_fanout_ms"] is not None  # 이 구간은 request_received_at과 무관하게 항상 채워짐


@pytest.mark.anyio
async def test_no_timing_log_when_status_unchanged(_capture):
    story = _story(status="todo")
    db = _mock_db()

    await emit_story_status_changed(db, uuid.uuid4(), story, "todo")

    assert _capture.records == []


@pytest.mark.anyio
async def test_timing_log_failure_does_not_break_emit(monkeypatch, _capture):
    """계측 로깅 자체가 실패해도(예: 로그 핸들러 고장) 이미 발화된 side-effect가 깨지면 안
    된다 — best-effort. `time.time()`은 CPython에서 사실상 무결함이라(다른 계측 콜사이트인
    context_pack.py도 방어 안 함) 그건 시뮬레이션 안 함 — 현실적 실패 지점인 logger.info를 문제
    삼는다."""
    monkeypatch.setattr("app.services.project_auth.project_accessible_member_ids", AsyncMock(return_value=set()))
    monkeypatch.setattr("app.services.webhook_dispatch.fire_webhooks", AsyncMock())
    monkeypatch.setattr("app.services.workflow_pipeline.process_event", AsyncMock())
    monkeypatch.setattr("app.services.trust_pipeline.emit_on_story_status_change", AsyncMock())
    monkeypatch.setattr(sse_mod.logger, "info", MagicMock(side_effect=RuntimeError("boom")))

    story = _story(status="in-progress")
    db = _mock_db()

    # 예외 전파 없이 정상 반환해야(계측 실패가 함수 전체를 깨면 안 됨).
    await emit_story_status_changed(db, uuid.uuid4(), story, "todo")


def test_route_handlers_capture_and_pass_request_received_at():
    """소스 검사 — 두 실 콜사이트(bulk/단건)가 요청 수신 시각을 캡처해 넘기는지 회귀 고정."""
    import inspect

    from app.routers import stories as stories_mod

    bulk_src = inspect.getsource(stories_mod.bulk_update_stories)
    assert "_request_received_at = time.time()" in bulk_src
    assert "request_received_at=_request_received_at" in bulk_src

    status_src = inspect.getsource(stories_mod.update_story_status)
    assert "_request_received_at = time.time()" in status_src
    assert "request_received_at=_request_received_at" in status_src
