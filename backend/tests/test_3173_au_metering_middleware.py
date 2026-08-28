"""story #3173(결제②-B) — AUMeteringMiddleware 판정 로직 회귀(실 DB 불요, record_au_usage
자체는 모킹). 미들웨어가 «언제 세고 언제 안 세는지»만 고정한다."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from app.services.au_metering import AUMeteringMiddleware


def _build_app(monkeypatch, *, au_actor: str | None, org_id: str | None = "11111111-1111-1111-1111-111111111111"):
    app = FastAPI()

    @app.middleware("http")
    async def _fake_auth(request: Request, call_next):
        request.state.au_actor = au_actor
        request.state.au_org_id = org_id
        return await call_next(request)

    app.add_middleware(AUMeteringMiddleware)

    @app.get("/api/v2/widgets")
    async def read_widgets():
        return JSONResponse({"data": []})

    @app.post("/api/v2/widgets")
    async def write_widget():
        return JSONResponse({"data": {"id": 1}}, status_code=201)

    @app.post("/api/v2/widgets/batch")
    async def write_widgets_batch():
        return JSONResponse({"data": []}, status_code=201, headers={"X-Affected-Entities": "7"})

    @app.get("/api/v2/widgets/missing")
    async def read_missing():
        return JSONResponse({"error": "nope"}, status_code=404)

    @app.get("/api/v2/events/stream")
    async def stream():
        return JSONResponse({"data": "would-be-sse"})

    recorded = []

    async def _fake_record(org_id, delta):
        recorded.append((str(org_id), delta))

    monkeypatch.setattr("app.services.au_metering.record_au_usage", AsyncMock(side_effect=_fake_record))
    return app, recorded


def test_agent_read_success_records_one_au(monkeypatch):
    app, recorded = _build_app(monkeypatch, au_actor="agent")
    client = TestClient(app)
    resp = client.get("/api/v2/widgets")
    assert resp.status_code == 200
    assert recorded == [("11111111-1111-1111-1111-111111111111", 1)]


def test_agent_write_success_records_five_au(monkeypatch):
    app, recorded = _build_app(monkeypatch, au_actor="agent")
    client = TestClient(app)
    resp = client.post("/api/v2/widgets")
    assert resp.status_code == 201
    assert recorded == [("11111111-1111-1111-1111-111111111111", 5)]


def test_agent_batch_write_uses_affected_entities_header(monkeypatch):
    app, recorded = _build_app(monkeypatch, au_actor="agent")
    client = TestClient(app)
    resp = client.post("/api/v2/widgets/batch")
    assert resp.status_code == 201
    assert recorded == [("11111111-1111-1111-1111-111111111111", 35)], (
        "X-Affected-Entities: 7 -> 5*7=35이어야 함"
    )


def test_human_traffic_never_counted(monkeypatch):
    """doc §4.5 — 사람 웹 UI 작업은 0 AU."""
    app, recorded = _build_app(monkeypatch, au_actor="human")
    client = TestClient(app)
    client.get("/api/v2/widgets")
    client.post("/api/v2/widgets")
    assert recorded == []


def test_unauthenticated_traffic_never_counted(monkeypatch):
    """au_actor가 아예 안 심긴(공개 엔드포인트 등) 경우도 세지 않는다."""
    app, recorded = _build_app(monkeypatch, au_actor=None)
    client = TestClient(app)
    client.get("/api/v2/widgets")
    assert recorded == []


def test_failed_response_never_counted(monkeypatch):
    """doc §4.5 — 인증 실패·유효성 실패·서버 5xx는 0 AU."""
    app, recorded = _build_app(monkeypatch, au_actor="agent")
    client = TestClient(app)
    resp = client.get("/api/v2/widgets/missing")
    assert resp.status_code == 404
    assert recorded == []


def test_streaming_path_never_counted(monkeypatch):
    """SSE denylist — 정확 경로만(라우터 prefix 전체 아님)."""
    app, recorded = _build_app(monkeypatch, au_actor="agent")
    client = TestClient(app)
    resp = client.get("/api/v2/events/stream")
    assert resp.status_code == 200
    assert recorded == []


def test_metering_exception_never_breaks_the_response(monkeypatch):
    """조건ⓐ(페드루 PO) — 계측 자체가 죽어도 응답은 절대 안 죽는다(fail-open)."""
    app, _ = _build_app(monkeypatch, au_actor="agent")
    monkeypatch.setattr(
        "app.services.au_metering.record_au_usage",
        AsyncMock(side_effect=RuntimeError("boom")),
    )
    client = TestClient(app)
    resp = client.get("/api/v2/widgets")
    assert resp.status_code == 200, "계측 예외가 응답을 깨뜨림 — fail-open 조건 위반"
