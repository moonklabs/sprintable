"""story #3173(결제②-B) — AUMeteringMiddleware 판정 로직 회귀(실 DB 불요, record_au_usage
자체는 모킹). 미들웨어가 «언제 세고 언제 안 세는지»·«응답 경로에서 분리됐는지»를 고정한다.

⚠️페드루 PO 리뷰(PR#3579, 2026-08-28) — 계측 DB 왕복은 `pg_pubsub.fire_and_forget()`
(canonical GC-safe 헬퍼, main.py lifespan의 drain과 이미 연동)로 응답 반환 밖에
던져진다(§6 설계). 그래서 여기는 sync `TestClient`가 아니라
`httpx.AsyncClient`+`ASGITransport`로 같은 이벤트루프를 유지하고, 매 요청 뒤
`_drain_background_tasks()`로 스케줄된 태스크가 실제로 끝나길 기다린 다음에야 assert한다
— 안 그러면 백그라운드 태스크가 돌기도 전에 테스트 함수가 끝나 항상 거짓양성(비어있음)이 뜬다."""
from __future__ import annotations

import asyncio
import uuid
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from httpx import ASGITransport, AsyncClient

from app.services.au_metering import AUMeteringMiddleware


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _drain_background_tasks() -> None:
    """dispatch()가 asyncio.create_task로 던진 계측 태스크가 실제로 끝날 때까지 대기.
    현재 실행 중인 테스트 코루틴 자신은 제외해야 한다(자기 자신을 gather하면 데드락)."""
    current = asyncio.current_task()
    pending = [t for t in asyncio.all_tasks() if t is not current and not t.done()]
    if pending:
        await asyncio.gather(*pending)


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
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    return client, recorded


@pytest.mark.anyio
async def test_metering_is_scheduled_as_background_task_not_awaited_inline(monkeypatch):
    """조건(페드루 PO, PR#3579) — dispatch()가 record_au_usage를 inline await하지 않는다.
    record_au_usage를 절대 안 끝나는 코루틴으로 바꿔도 응답은 즉시 돌아와야 한다."""
    app = FastAPI()

    @app.middleware("http")
    async def _fake_auth(request: Request, call_next):
        request.state.au_actor = "agent"
        request.state.au_org_id = "11111111-1111-1111-1111-111111111111"
        return await call_next(request)

    app.add_middleware(AUMeteringMiddleware)

    @app.get("/api/v2/widgets")
    async def read_widgets():
        return JSONResponse({"data": []})

    hung = asyncio.Event()

    async def _never_returns(org_id, delta):
        await hung.wait()  # 응답이 이걸 기다리면 이 테스트 자체가 타임아웃으로 실패한다.

    monkeypatch.setattr("app.services.au_metering.record_au_usage", AsyncMock(side_effect=_never_returns))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await asyncio.wait_for(client.get("/api/v2/widgets"), timeout=2.0)
    assert resp.status_code == 200
    hung.set()  # 정리 — 매달린 태스크 해제.
    await _drain_background_tasks()


@pytest.mark.anyio
async def test_metering_task_uses_canonical_fire_and_forget(monkeypatch):
    """페드루 PO 자인(PR#3579, 카디르 QA 적발) — 최초 델타가 GC 조기수거 처방을 모듈
    로컬 `asyncio.create_task`+새 set으로 직접 재구현했다가, 이미 레포에 있던 canonical
    헬퍼 `pg_pubsub.fire_and_forget()`(main.py lifespan의 `drain_background_tasks()`와
    이미 연동된 바로 그 강한참조 세트)를 재사용하도록 정정됐다. 이 테스트는 au_metering이
    독자적인 태스크 세트를 다시 만들지 않고 `pg_pubsub`의 세트를 그대로 쓰는지 직접
    확認한다 — 재발 시(다시 로컬 set을 만들면) 이 assert가 곧바로 잡는다."""
    import app.services.au_metering as au_metering
    from app.services import pg_pubsub

    release = asyncio.Event()
    started = asyncio.Event()

    async def _slow(org_id, delta):
        started.set()
        await release.wait()

    monkeypatch.setattr(au_metering, "record_au_usage", AsyncMock(side_effect=_slow))

    before = len(pg_pubsub._background_tasks)
    au_metering.fire_and_forget(au_metering._record_au_usage_safe(uuid.uuid4(), 1))
    await started.wait()
    assert len(pg_pubsub._background_tasks) == before + 1, (
        "au_metering이 pg_pubsub의 canonical 강한참조 세트를 쓰고 있어야 함"
    )

    release.set()
    await _drain_background_tasks()
    assert len(pg_pubsub._background_tasks) == before, "완료 후엔 done_callback이 discard해야 함"


@pytest.mark.anyio
async def test_agent_read_success_records_one_au(monkeypatch):
    client, recorded = _build_app(monkeypatch, au_actor="agent")
    async with client:
        resp = await client.get("/api/v2/widgets")
        await _drain_background_tasks()
    assert resp.status_code == 200
    assert recorded == [("11111111-1111-1111-1111-111111111111", 1)]


@pytest.mark.anyio
async def test_agent_write_success_records_five_au(monkeypatch):
    client, recorded = _build_app(monkeypatch, au_actor="agent")
    async with client:
        resp = await client.post("/api/v2/widgets")
        await _drain_background_tasks()
    assert resp.status_code == 201
    assert recorded == [("11111111-1111-1111-1111-111111111111", 5)]


@pytest.mark.anyio
async def test_agent_batch_write_uses_affected_entities_header(monkeypatch):
    client, recorded = _build_app(monkeypatch, au_actor="agent")
    async with client:
        resp = await client.post("/api/v2/widgets/batch")
        await _drain_background_tasks()
    assert resp.status_code == 201
    assert recorded == [("11111111-1111-1111-1111-111111111111", 35)], (
        "X-Affected-Entities: 7 -> 5*7=35이어야 함"
    )


@pytest.mark.anyio
async def test_human_traffic_never_counted(monkeypatch):
    """doc §4.5 — 사람 웹 UI 작업은 0 AU."""
    client, recorded = _build_app(monkeypatch, au_actor="human")
    async with client:
        await client.get("/api/v2/widgets")
        await client.post("/api/v2/widgets")
        await _drain_background_tasks()
    assert recorded == []


@pytest.mark.anyio
async def test_unauthenticated_traffic_never_counted(monkeypatch):
    """au_actor가 아예 안 심긴(공개 엔드포인트 등) 경우도 세지 않는다."""
    client, recorded = _build_app(monkeypatch, au_actor=None)
    async with client:
        await client.get("/api/v2/widgets")
        await _drain_background_tasks()
    assert recorded == []


@pytest.mark.anyio
async def test_failed_response_never_counted(monkeypatch):
    """doc §4.5 — 인증 실패·유효성 실패·서버 5xx는 0 AU."""
    client, recorded = _build_app(monkeypatch, au_actor="agent")
    async with client:
        resp = await client.get("/api/v2/widgets/missing")
        await _drain_background_tasks()
    assert resp.status_code == 404
    assert recorded == []


@pytest.mark.anyio
async def test_streaming_path_never_counted(monkeypatch):
    """SSE denylist — 정확 경로만(라우터 prefix 전체 아님)."""
    client, recorded = _build_app(monkeypatch, au_actor="agent")
    async with client:
        resp = await client.get("/api/v2/events/stream")
        await _drain_background_tasks()
    assert resp.status_code == 200
    assert recorded == []


@pytest.mark.anyio
async def test_metering_exception_never_breaks_the_response(monkeypatch):
    """조건ⓐ(페드루 PO) — 계측 자체가 죽어도 응답은 절대 안 죽는다(fail-open). 백그라운드
    태스크 안에서 터진 예외도(_record_au_usage_safe) 삼켜져야 한다 — 안 그러면 "Task
    exception was never retrieved"로 인터프리터가 시끄러워진다."""
    app = FastAPI()

    @app.middleware("http")
    async def _fake_auth(request: Request, call_next):
        request.state.au_actor = "agent"
        request.state.au_org_id = "11111111-1111-1111-1111-111111111111"
        return await call_next(request)

    app.add_middleware(AUMeteringMiddleware)

    @app.get("/api/v2/widgets")
    async def read_widgets():
        return JSONResponse({"data": []})

    monkeypatch.setattr(
        "app.services.au_metering.record_au_usage",
        AsyncMock(side_effect=RuntimeError("boom")),
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/v2/widgets")
        await _drain_background_tasks()  # 예외를 삼키는지까지 확認(안 삼키면 여기서 raise)
    assert resp.status_code == 200, "계측 예외가 응답을 깨뜨림 — fail-open 조건 위반"
