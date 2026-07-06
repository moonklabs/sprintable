"""E-A2A-POC S1(story 480e81fb): Agent Card + JSON-RPC(SendMessage/GetTask) 단위 테스트."""
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

MEMBER_ID = uuid.uuid4()


def _mock_member(agent_role: str | None = "qa") -> MagicMock:
    m = MagicMock()
    m.id = MEMBER_ID
    m.name = "Kkasim"
    m.type = "agent"
    m.is_active = True
    m.agent_role = agent_role
    return m


def _mock_persona() -> MagicMock:
    p = MagicMock()
    p.agent_id = MEMBER_ID
    p.name = "QA Engineer"
    p.slug = "qa"
    p.description = "QA testing role"
    p.config = {"tool_allowlist": ["stories", "tasks", "chat"]}
    p.is_default = True
    p.deleted_at = None
    return p


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client():
    from app.main import app

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    from app.dependencies.database import get_db

    app.dependency_overrides[get_db] = override_db

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


def _result(value):
    r = MagicMock()
    r.scalar_one_or_none.return_value = value
    return r


# ── Agent Card ────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_agent_card_200_reflects_role_template_skills():
    client, session, app = await _client()
    try:
        member = _mock_member()
        persona = _mock_persona()

        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            return _result(member) if call_count == 1 else _result(persona)

        session.execute = mock_execute

        async with client as c:
            resp = await c.get(f"/api/v2/a2a/members/{MEMBER_ID}/agent-card.json")

        assert resp.status_code == 200
        card = resp.json()
        assert card["name"] == "Kkasim"
        assert card["skills"][0]["tags"] == ["stories", "tasks", "chat"]
        assert card["skills"][0]["id"] == "qa"
        assert card["supportedInterfaces"][0]["protocolBinding"] == "JSONRPC"
        assert card["supportedInterfaces"][0]["protocolVersion"] == "1.0"
        assert card["supportedInterfaces"][0]["tenant"] == str(MEMBER_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_agent_card_200_unassigned_agent_fallback_skill():
    """persona 없음(미채용) — team_members.agent_role 기반 최소 skill 하나로 폴백, 크래시 없음."""
    client, session, app = await _client()
    try:
        member = _mock_member(agent_role=None)

        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            return _result(member) if call_count == 1 else _result(None)

        session.execute = mock_execute

        async with client as c:
            resp = await c.get(f"/api/v2/a2a/members/{MEMBER_ID}/agent-card.json")

        assert resp.status_code == 200
        card = resp.json()
        assert card["skills"][0]["tags"] == []
        assert card["skills"][0]["id"] == "unassigned"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_agent_card_404_unknown_member():
    client, session, app = await _client()
    try:
        session.execute = AsyncMock(return_value=_result(None))

        async with client as c:
            resp = await c.get(f"/api/v2/a2a/members/{uuid.uuid4()}/agent-card.json")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


# ── JSON-RPC: SendMessage / GetTask ────────────────────────────────────────────


@pytest.mark.anyio
async def test_send_message_returns_completed_task():
    client, session, app = await _client()
    try:
        member = _mock_member()
        session.execute = AsyncMock(return_value=_result(member))
        session.flush = AsyncMock()
        session.commit = AsyncMock()

        async def fake_refresh(obj):
            obj.updated_at = obj.updated_at or __import__("datetime").datetime.now(
                __import__("datetime").timezone.utc
            )

        session.refresh = AsyncMock(side_effect=fake_refresh)

        req = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "SendMessage",
            "params": {
                "message": {
                    "messageId": str(uuid.uuid4()),
                    "role": "ROLE_USER",
                    "parts": [{"text": "hello"}],
                }
            },
        }

        async with client as c:
            resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=req)

        assert resp.status_code == 200
        body = resp.json()
        assert body["jsonrpc"] == "2.0"
        assert body["id"] == 1
        assert body["result"]["status"]["state"] == "TASK_STATE_COMPLETED"
        assert body["error"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_send_message_invalid_params_returns_jsonrpc_error():
    client, session, app = await _client()
    try:
        member = _mock_member()
        session.execute = AsyncMock(return_value=_result(member))

        req = {"jsonrpc": "2.0", "id": 1, "method": "SendMessage", "params": {}}

        async with client as c:
            resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=req)

        assert resp.status_code == 200
        body = resp.json()
        assert body["error"]["code"] == -32602
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_task_200():
    client, session, app = await _client()
    try:
        member = _mock_member()
        task_id = uuid.uuid4()
        task = MagicMock()
        task.id = task_id
        task.context_id = uuid.uuid4()
        task.state = "TASK_STATE_COMPLETED"
        task.artifacts = []
        task.history = []
        import datetime

        task.updated_at = datetime.datetime.now(datetime.timezone.utc)

        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            return _result(member) if call_count == 1 else _result(task)

        session.execute = mock_execute

        req = {"jsonrpc": "2.0", "id": 2, "method": "GetTask", "params": {"id": str(task_id)}}

        async with client as c:
            resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=req)

        assert resp.status_code == 200
        body = resp.json()
        assert body["result"]["id"] == str(task_id)
        assert body["result"]["status"]["state"] == "TASK_STATE_COMPLETED"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_task_not_found_returns_a2a_error():
    client, session, app = await _client()
    try:
        member = _mock_member()

        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            return _result(member) if call_count == 1 else _result(None)

        session.execute = mock_execute

        req = {"jsonrpc": "2.0", "id": 3, "method": "GetTask", "params": {"id": str(uuid.uuid4())}}

        async with client as c:
            resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=req)

        body = resp.json()
        assert body["error"]["code"] == -32001
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_unknown_method_returns_method_not_found():
    client, session, app = await _client()
    try:
        member = _mock_member()
        session.execute = AsyncMock(return_value=_result(member))

        req = {"jsonrpc": "2.0", "id": 4, "method": "DoesNotExist", "params": {}}

        async with client as c:
            resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=req)

        body = resp.json()
        assert body["error"]["code"] == -32601
    finally:
        app.dependency_overrides.clear()
