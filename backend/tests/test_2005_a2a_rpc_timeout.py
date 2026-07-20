"""story #2005(Phase B P1-c, E-A2A-PROTO 리라이어빌리티): `/rpc` 타임아웃 명시화 검증.

배경(grep 확認, story 스펙): `/rpc`엔 서버 핸들러 상한이 전혀 없었다(`asyncio.wait_for`/
`asyncio.timeout` 0건, 전체 `a2a.py`) — 유일한 상한은 Cloud Run 플랫폼 타임아웃뿐이었고, 그마저도
`cloudbuild.yaml`에 `--timeout` 플래그가 명시된 적이 없어 인프라 기본값에 암묵 의존 중이었다.
이 파일은 그 갭을 메운 `_A2A_RPC_TIMEOUT_SECONDS`(non-streaming 핸들러 상한)와 SSE
overall-ceiling(`_stream_send_message.generate()`)이 실제로 동작하는지를 검증한다.

이 스토리는 lower-stakes(low-priority/lightweight)로 명시돼 mock/unit 중심 — story #2003·
S-A4의 기존 mock 패턴(test_a2a.py의 `_authed_client`/`_mock_member`/`_result`, S-A4 realdb
스트리밍 테스트의 `_stream_send_message` 직접 순회 패턴)을 그대로 재사용한다. 실 280초/300초를
기다리지 않도록 `_A2A_RPC_TIMEOUT_SECONDS`(+ SSE 쪽은 `_STREAM_POLL_INTERVAL_SECONDS`도 함께)를
monkeypatch로 test-friendly 값으로 낮춘다."""
from __future__ import annotations

import asyncio
import json
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.routers import a2a as a2a_mod

MEMBER_ID = uuid.uuid4()


def _mock_member() -> MagicMock:
    m = MagicMock()
    m.id = MEMBER_ID
    m.org_id = uuid.uuid4()
    m.name = "Timeout Test Agent"
    m.type = "agent"
    m.is_active = True
    return m


def _result(value):
    """test_a2a.py와 동일 헬퍼 — `_get_agent_member`가 `.scalars().first()`로 조회한다."""
    r = MagicMock()
    r.scalar_one_or_none.return_value = value
    r.scalar_one.return_value = value
    r.first.return_value = value
    r.scalars.return_value.first.return_value = value
    return r


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _authed_client(org_id: uuid.UUID):
    """test_a2a.py의 `_authed_client`와 동형(중복 최소화보다 이 파일의 독립성을 우선 — 기존
    테스트 파일을 이 파일이 import하면 그 파일의 fixture/전역상태에 암묵 결합된다)."""
    from app.main import app
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        ctx = MagicMock()
        ctx.user_id = str(uuid.uuid4())
        ctx.claims = {"app_metadata": {"org_id": str(org_id)}}
        return ctx

    async def override_org():
        return org_id

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth
    app.dependency_overrides[get_verified_org_id] = override_org

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


# ── 상수 sanity ──────────────────────────────────────────────────────────────


def test_timeout_constant_is_below_po_measured_prod_cloud_run_ceiling():
    """PO 실측(2026-07-17): backend-prod 실효 Cloud Run 타임아웃=300s. 애플리케이션 상한은
    그보다 낮아야(플랫폼이 커넥션을 강제로 끊기 전에 앱이 먼저 깔끔한 에러를 낼 수 있게) 의미가
    있다 — 역전되면(>=300) 이 스토리의 핵심 목적(원시 커넥션 킬 방지) 자체가 무의미해진다."""
    assert 0 < a2a_mod._A2A_RPC_TIMEOUT_SECONDS < 300


def test_timeout_error_code_does_not_collide_with_existing_custom_codes():
    """story #2003이 도입한 -32010(_UNAUTHORIZED)/-32011(_AGENT_NOT_FOUND)와 미충돌 + 표준
    JSON-RPC 코드(-32601/-32602/-32603)와도 미충돌 — 신규 -32012가 실제로 '다음 free 번호'인지
    코드 레벨로 고정."""
    existing = {
        a2a_mod._METHOD_NOT_FOUND, a2a_mod._INVALID_PARAMS, a2a_mod._TASK_NOT_FOUND,
        a2a_mod._VERSION_NOT_SUPPORTED, a2a_mod._UNAUTHORIZED, a2a_mod._AGENT_NOT_FOUND,
        a2a_mod._INTERNAL_ERROR,
    }
    assert a2a_mod._REQUEST_TIMEOUT == -32012
    assert a2a_mod._REQUEST_TIMEOUT not in existing


# ── AC1: 느린/행 핸들러 → 클린 JSON-RPC 타임아웃 에러(핸행 없음) ────────────────


@pytest.mark.anyio
async def test_slow_method_handler_times_out_with_clean_jsonrpc_error():
    client, session, app = await _authed_client(uuid.uuid4())
    try:
        member = _mock_member()
        session.execute = AsyncMock(return_value=_result(member))

        hang_started = asyncio.Event()

        async def _hanging_handler(*_a, **_kw):
            hang_started.set()
            await asyncio.sleep(5)  # patched 타임아웃(아래)보다 훨씬 김 — 실제로 5초 기다리면 FAIL
            return {"never": "reached"}  # pragma: no cover

        req = {"jsonrpc": "2.0", "id": "slow-1", "method": "SlowMethod", "params": {}}

        with patch.dict(a2a_mod._METHODS, {"SlowMethod": _hanging_handler}), \
             patch.object(a2a_mod, "_A2A_RPC_TIMEOUT_SECONDS", 0.05):
            async with client as c:
                resp = await asyncio.wait_for(
                    c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=req), timeout=10,
                )

        assert hang_started.is_set()  # 핸들러가 실제로 호출됐음(타임아웃이 호출 자체를 막은 게 아님)
        assert resp.status_code == 200, resp.text  # story #2003 컨벤션: transport=200, 에러는 body
        body = resp.json()
        assert body["jsonrpc"] == "2.0"
        assert body["id"] == "slow-1"
        assert body["result"] is None
        error = body["error"]
        assert isinstance(error["code"], int)
        assert error["code"] == a2a_mod._REQUEST_TIMEOUT
        assert error["data"]["retryable"] is True
        assert "0.05" in error["message"] or "timeout" in error["message"].lower()
    finally:
        app.dependency_overrides.clear()


# ── AC2: 정상 빠른 호출은 무회귀(회귀 가드) ─────────────────────────────────────


@pytest.mark.anyio
async def test_fast_method_completes_normally_under_timeout():
    client, session, app = await _authed_client(uuid.uuid4())
    try:
        member = _mock_member()
        session.execute = AsyncMock(return_value=_result(member))

        async def _fast_handler(*_a, **_kw):
            return {"ok": True, "echoed": True}

        req = {"jsonrpc": "2.0", "id": "fast-1", "method": "FastMethod", "params": {}}

        with patch.dict(a2a_mod._METHODS, {"FastMethod": _fast_handler}), \
             patch.object(a2a_mod, "_A2A_RPC_TIMEOUT_SECONDS", 5.0):
            async with client as c:
                resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=req)

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["error"] is None
        assert body["result"] == {"ok": True, "echoed": True}
    finally:
        app.dependency_overrides.clear()


# ── AC3: SSE — 무기한 스트림이 overall ceiling에서 깔끔히 종료 ──────────────────


class _FakeDbCtx:
    """`async_session_factory()`의 `async with ... as db:` 대역 — 매 tick 항상 동일한
    (never-completing) TASK_STATE_WORKING 행을 반환."""

    def __init__(self, task_row):
        self._task_row = task_row

    async def __aenter__(self):
        db = AsyncMock()
        result = MagicMock()
        result.scalar_one_or_none.return_value = self._task_row
        db.execute = AsyncMock(return_value=result)
        return db

    async def __aexit__(self, *_exc):
        return False


def _mock_stream_request() -> MagicMock:
    req = MagicMock()
    req.is_disconnected = AsyncMock(return_value=False)
    return req


@pytest.mark.anyio
async def test_sse_stream_terminates_at_overall_ceiling_instead_of_running_forever():
    """느린/never-ending 스트림 제너레이터를 모킹(task가 영원히 TASK_STATE_WORKING) — 실제
    S-A4 폴링 로직이라면 클라가 붙어있는 한(`is_disconnected`=False 고정) 영원히 안 끝난다.
    overall-ceiling이 없으면 이 테스트는 타임아웃(무한루프)으로 실패한다."""
    member = _mock_member()
    task_row = MagicMock()
    task_row.state = "TASK_STATE_WORKING"

    send_result = {
        "task": {
            "id": str(uuid.uuid4()),
            "contextId": str(uuid.uuid4()),
            "status": {"state": "TASK_STATE_WORKING"},
        }
    }

    session = AsyncMock()

    with patch.object(a2a_mod, "_handle_send_message", new=AsyncMock(return_value=send_result)), \
         patch.object(a2a_mod, "async_session_factory", side_effect=lambda: _FakeDbCtx(task_row)), \
         patch.object(a2a_mod, "_advance_task_state", new=AsyncMock(return_value=task_row)), \
         patch.object(
             a2a_mod, "_task_to_dict",
             return_value={**send_result["task"], "artifacts": []},
         ), \
         patch.object(a2a_mod, "_A2A_RPC_TIMEOUT_SECONDS", 0.05), \
         patch.object(a2a_mod, "_STREAM_POLL_INTERVAL_SECONDS", 0.01):
        resp = await a2a_mod._stream_send_message(
            _mock_stream_request(), "stream-1", session, member, member.org_id, {}, frozenset(),
        )

        gen = resp.body_iterator
        first = await asyncio.wait_for(gen.__anext__(), timeout=5)
        assert '"task"' in first

        frames: list[dict] = []
        async for chunk in _bounded(gen, overall_timeout=5):
            for line in chunk.split("\n"):
                if line.startswith("data: "):
                    frames.append(json.loads(line[len("data: "):]))

    assert frames, "expected a terminal error frame before the stream closed"
    last = frames[-1]
    assert "error" in last and last.get("result") is None
    assert last["error"]["code"] == a2a_mod._REQUEST_TIMEOUT
    assert last["error"]["data"]["retryable"] is True
    assert last["id"] == "stream-1"


async def _bounded(gen, *, overall_timeout: float):
    """async generator를 순회하되 전체 소요시간을 감싸 테스트 자체가 실수로 무한 대기하지
    않도록 방어(overall-ceiling 구현에 버그가 있어도 CI가 행 걸리는 대신 명확히 FAIL)."""
    async def _drain():
        async for item in gen:
            yield item

    it = _drain()
    while True:
        try:
            item = await asyncio.wait_for(it.__anext__(), timeout=overall_timeout)
        except StopAsyncIteration:
            return
        yield item
