"""story #3722 — ToolCallRecordingMiddleware 판정 로직 회귀(실 DB 불요, DB 왕복 자체는
모킹). test_3173_au_metering_middleware.py와 동형 패턴 — fire_and_forget()으로 응답
반환 밖에 던져지므로 httpx.AsyncClient+ASGITransport로 같은 이벤트루프를 유지하고
`_drain_background_tasks()`로 실제로 끝나길 기다린 뒤에야 assert한다."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from httpx import ASGITransport, AsyncClient

from app.services.tool_call_recording import ToolCallRecordingMiddleware


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _drain_background_tasks() -> None:
    current = asyncio.current_task()
    pending = [t for t in asyncio.all_tasks() if t is not current and not t.done()]
    if pending:
        await asyncio.gather(*pending)


def _build_app(monkeypatch, *, au_actor: str | None, org_id: str | None = "11111111-1111-1111-1111-111111111111",
               agent_id: str | None = "22222222-2222-2222-2222-222222222222"):
    app = FastAPI()

    @app.middleware("http")
    async def _fake_auth(request: Request, call_next):
        request.state.au_actor = au_actor
        request.state.au_org_id = org_id
        request.state.au_user_id = agent_id
        return await call_next(request)

    app.add_middleware(ToolCallRecordingMiddleware)

    @app.get("/api/v2/widgets")
    async def read_widgets():
        return JSONResponse({"data": []})

    @app.post("/api/v2/stories/{id}/status")
    async def update_story_status(id: str):
        return JSONResponse({"data": {"id": id}}, status_code=200)

    @app.get("/api/v2/widgets/missing")
    async def read_missing():
        return JSONResponse({"error": "nope"}, status_code=404)

    @app.get("/api/v2/events/stream")
    async def stream():
        return JSONResponse({"data": "would-be-sse"})

    recorded = []

    async def _fake_insert(session, **kwargs):
        recorded.append(kwargs)

    monkeypatch.setattr("app.services.tool_call_recording.attribute_and_insert", AsyncMock(side_effect=_fake_insert))
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    return client, recorded


@pytest.mark.anyio
async def test_agent_request_is_recorded_with_method_path_status_duration(monkeypatch):
    client, recorded = _build_app(monkeypatch, au_actor="agent")
    async with client:
        resp = await client.get("/api/v2/widgets")
        await _drain_background_tasks()
    assert resp.status_code == 200
    assert len(recorded) == 1
    call = recorded[0]
    assert call["method"] == "GET"
    assert call["path"] == "/api/v2/widgets"
    assert call["status_code"] == 200
    assert call["duration_ms"] >= 0
    assert call["error"] is None


@pytest.mark.anyio
async def test_human_traffic_never_recorded(monkeypatch):
    client, recorded = _build_app(monkeypatch, au_actor="human")
    async with client:
        resp = await client.get("/api/v2/widgets")
        await _drain_background_tasks()
    assert resp.status_code == 200
    assert recorded == []


@pytest.mark.anyio
async def test_unauthenticated_traffic_never_recorded(monkeypatch):
    client, recorded = _build_app(monkeypatch, au_actor=None)
    async with client:
        resp = await client.get("/api/v2/widgets")
        await _drain_background_tasks()
    assert resp.status_code == 200
    assert recorded == []


@pytest.mark.anyio
async def test_streaming_path_never_recorded(monkeypatch):
    client, recorded = _build_app(monkeypatch, au_actor="agent")
    async with client:
        resp = await client.get("/api/v2/events/stream")
        await _drain_background_tasks()
    assert resp.status_code == 200
    assert recorded == []


@pytest.mark.anyio
async def test_failed_response_is_still_recorded_with_error_set():
    """AC — "성공・실패 모두" 기록된다(AU 계측과 다른 지점: 그쪽은 실패를 아예 안 세지만
    이 스토리는 실패야말로 Trust 신호의 핵심이라 반드시 남긴다)."""
    from unittest import mock
    app = FastAPI()

    @app.middleware("http")
    async def _fake_auth(request: Request, call_next):
        request.state.au_actor = "agent"
        request.state.au_org_id = "11111111-1111-1111-1111-111111111111"
        request.state.au_user_id = "22222222-2222-2222-2222-222222222222"
        return await call_next(request)

    app.add_middleware(ToolCallRecordingMiddleware)

    @app.get("/api/v2/widgets/missing")
    async def read_missing():
        return JSONResponse({"error": "nope"}, status_code=404)

    recorded = []

    async def _fake_insert(session, **kwargs):
        recorded.append(kwargs)

    with mock.patch("app.services.tool_call_recording.attribute_and_insert", AsyncMock(side_effect=_fake_insert)):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/v2/widgets/missing")
            await _drain_background_tasks()
    assert resp.status_code == 404
    assert len(recorded) == 1
    assert recorded[0]["status_code"] == 404
    assert recorded[0]["error"] == "HTTP 404"


@pytest.mark.anyio
async def test_recording_never_blocks_response_even_if_insert_hangs(monkeypatch):
    """조건(AUMeteringMiddleware와 동형 규율) — dispatch()가 attribute_and_insert를
    inline await하지 않는다. 절대 안 끝나는 코루틴으로 바꿔도 응답은 즉시 돌아와야 한다."""
    app = FastAPI()

    @app.middleware("http")
    async def _fake_auth(request: Request, call_next):
        request.state.au_actor = "agent"
        request.state.au_org_id = "11111111-1111-1111-1111-111111111111"
        request.state.au_user_id = "22222222-2222-2222-2222-222222222222"
        return await call_next(request)

    app.add_middleware(ToolCallRecordingMiddleware)

    @app.get("/api/v2/widgets")
    async def read_widgets():
        return JSONResponse({"data": []})

    hung = asyncio.Event()

    async def _never_returns(session, **kwargs):
        await hung.wait()

    monkeypatch.setattr("app.services.tool_call_recording.attribute_and_insert", AsyncMock(side_effect=_never_returns))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await asyncio.wait_for(client.get("/api/v2/widgets"), timeout=2.0)
    assert resp.status_code == 200
    hung.set()
    await _drain_background_tasks()


@pytest.mark.anyio
async def test_recording_exception_never_breaks_the_response(monkeypatch):
    """`_record_tool_call_safe`가 예외를 삼키는지(=원 요청에 절대 안 새는지) 확認."""
    client, _ = _build_app(monkeypatch, au_actor="agent")
    monkeypatch.setattr(
        "app.services.tool_call_recording.attribute_and_insert",
        AsyncMock(side_effect=RuntimeError("boom")),
    )
    async with client:
        resp = await client.get("/api/v2/widgets")
        await _drain_background_tasks()  # 예외를 삼키는지까지 확認(안 삼키면 여기서 raise)
    assert resp.status_code == 200


@pytest.mark.anyio
async def test_story_id_extracted_from_path_param_and_passed_to_attribution(monkeypatch):
    client, recorded = _build_app(monkeypatch, au_actor="agent")
    async with client:
        resp = await client.post("/api/v2/stories/s-123/status", json={"status": "done"})
        await _drain_background_tasks()
    assert resp.status_code == 200
    assert len(recorded) == 1
    assert recorded[0]["story_id"] == "s-123"
    assert recorded[0]["input_summary"]["path"] == {"id": "s-123"}, (
        "story #3722 페드루 PO 追加 — path_params가 input_summary에 실려야"
    )


@pytest.mark.anyio
async def test_body_secrets_masked_before_recording(monkeypatch):
    client, recorded = _build_app(monkeypatch, au_actor="agent")
    async with client:
        resp = await client.post(
            "/api/v2/stories/s-1/status", json={"status": "done", "api_token": "sk_live_should_not_leak"},
        )
        await _drain_background_tasks()
    assert resp.status_code == 200
    summary = recorded[0]["input_summary"]
    assert summary["body"]["api_token"] == "[REDACTED]"
    assert "sk_live_should_not_leak" not in str(summary)
