"""E-A2A-POC S1+S2(story 480e81fb·1485217f): Agent Card + JSON-RPC(SendMessage/GetTask) +
CC 어댑터(fakechat 대체 — task-thread 완료 폴링) 단위 테스트."""
import datetime
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

MEMBER_ID = uuid.uuid4()


def _mock_member(agent_role: str | None = "qa") -> MagicMock:
    m = MagicMock()
    m.id = MEMBER_ID
    m.name = "Qasim"
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
    r.scalar_one.return_value = value
    r.first.return_value = value
    return r


def _list_result(items):
    r = MagicMock()
    r.scalars.return_value.all.return_value = items
    return r


def _mock_agent(member_id, name, agent_role="qa"):
    m = MagicMock()
    m.id = member_id
    m.name = name
    m.type = "agent"
    m.is_active = True
    m.agent_role = agent_role
    return m


async def _authed_client(org_id: uuid.UUID):
    from app.main import app
    from app.dependencies.auth import get_current_user, get_verified_org_id

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    from app.dependencies.database import get_db

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


def _multi_row_result():
    """라이브 E2E MUST(2026-07-06): 활성 WebhookConfig가 여러 개인 멤버 — .scalar_one_or_none()/
    .scalar_one()을 호출하면 MultipleResultsFound가 나야 정상(회귀 감지용), .first()만 안전."""
    from sqlalchemy.exc import MultipleResultsFound

    r = MagicMock()
    r.scalar_one_or_none.side_effect = MultipleResultsFound("multiple rows")
    r.scalar_one.side_effect = MultipleResultsFound("multiple rows")
    r.first.return_value = (uuid.uuid4(),)
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
        assert card["name"] == "Qasim"
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


# ── S3: 발견 — GET /members (authed, skill 필터) ──────────────────────────────


@pytest.mark.anyio
async def test_list_agent_cards_filters_by_skill_zero_hardcoding():
    """S3(story 5578a8e2): skill 쿼리 하나로 role-id 매칭 에이전트만 발견 — member_id 하드코딩 없음."""
    org_id = uuid.uuid4()
    qa_id, backend_id = uuid.uuid4(), uuid.uuid4()
    client, session, app = await _authed_client(org_id)
    try:
        qa_persona = _mock_persona()
        qa_persona.agent_id = qa_id

        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return _list_result([_mock_agent(qa_id, "Qasim"), _mock_agent(backend_id, "Didi", "backend")])
            if call_count == 2:
                return _result(qa_persona)
            return _result(None)  # backend agent has no matching persona in this fixture

        session.execute = mock_execute

        async with client as c:
            resp = await c.get("/api/v2/a2a/members", params={"skill": "qa"})

        assert resp.status_code == 200
        cards = resp.json()
        assert [c["name"] for c in cards] == ["Qasim"]
        assert cards[0]["supportedInterfaces"][0]["tenant"] == str(qa_id)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_agent_cards_no_filter_returns_all_org_agents():
    org_id = uuid.uuid4()
    a_id, b_id = uuid.uuid4(), uuid.uuid4()
    client, session, app = await _authed_client(org_id)
    try:
        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return _list_result([_mock_agent(a_id, "A"), _mock_agent(b_id, "B")])
            return _result(None)

        session.execute = mock_execute

        async with client as c:
            resp = await c.get("/api/v2/a2a/members")

        assert resp.status_code == 200
        assert {c["name"] for c in resp.json()} == {"A", "B"}
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_agent_cards_requires_auth():
    """S3: 개별 member_id 엔드포인트(S1/S2)와 달리 로스터 열거는 인증 필수(PO 판정)."""
    from app.main import app
    from app.dependencies.database import get_db

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    app.dependency_overrides[get_db] = override_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get("/api/v2/a2a/members")
        assert resp.status_code in (401, 403)
    finally:
        app.dependency_overrides.clear()


# ── JSON-RPC: SendMessage / GetTask ────────────────────────────────────────────


def _mock_task(state: str, artifacts=None, history=None, root_message_id=None, context_id=None,
               created_at=None, task_metadata=None) -> MagicMock:
    t = MagicMock()
    t.id = uuid.uuid4()
    t.context_id = context_id or uuid.uuid4()
    t.root_message_id = root_message_id
    t.state = state
    t.artifacts = artifacts or []
    t.history = history or []
    t.updated_at = datetime.datetime.now(datetime.timezone.utc)
    t.created_at = created_at or datetime.datetime.now(datetime.timezone.utc)
    t.task_metadata = task_metadata
    return t


_SEND_REQ = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "SendMessage",
    "params": {
        "message": {
            "messageId": str(uuid.uuid4()),
            "role": "ROLE_USER",
            "parts": [{"text": "please check the QA status"}],
        }
    },
}


@pytest.mark.anyio
async def test_send_message_working_when_webhook_configured():
    """S2: webhook 있으면 task-thread 생성 + webhook 전달 후 WORKING(즉시 COMPLETED 아님 —
    완료는 CC의 thread 답신을 GetTask가 폴링해야 발생, PO 크럭스 채택안)."""
    client, session, app = await _authed_client(uuid.uuid4())
    try:
        member = _mock_member()
        working_task = _mock_task("TASK_STATE_WORKING")

        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return _result(member)
            if call_count == 2:
                return _list_result([MEMBER_ID])  # active_webhook_member_ids: 활성 webhook 존재
            return _result(working_task)  # 최종 requery

        session.execute = mock_execute
        session.flush = AsyncMock()
        session.commit = AsyncMock()

        with patch("app.routers.a2a.deliver_conversation_message_webhook", new_callable=AsyncMock) as mock_deliver:
            async with client as c:
                resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=_SEND_REQ)
            mock_deliver.assert_called_once()

        assert resp.status_code == 200
        body = resp.json()
        assert body["result"]["status"]["state"] == "TASK_STATE_WORKING"
        assert body["error"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_send_message_working_when_member_has_multiple_active_webhooks():
    """라이브 E2E MUST(2026-07-06, 오르테가군 스모크 발견)+P1-S3 §10(SSOT 교체 후 회귀 확認):
    member-global+project별로 활성 WebhookConfig가 여러 개(디디 본인 케이스)여도 500 없이
    WORKING — active_webhook_member_ids는 .scalars().all()+set()이라 다중 행이 와도 예외가
    없다(SSOT 자체가 이 케이스를 이미 안전하게 처리)."""
    client, session, app = await _authed_client(uuid.uuid4())
    try:
        member = _mock_member()
        working_task = _mock_task("TASK_STATE_WORKING")

        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return _result(member)
            if call_count == 2:
                return _list_result([MEMBER_ID, MEMBER_ID])  # 활성 webhook 2개 이상(같은 멤버) 시뮬레이션
            return _result(working_task)

        session.execute = mock_execute
        session.flush = AsyncMock()
        session.commit = AsyncMock()

        with patch("app.routers.a2a.deliver_conversation_message_webhook", new_callable=AsyncMock) as mock_deliver:
            async with client as c:
                resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=_SEND_REQ)
            mock_deliver.assert_called_once()

        assert resp.status_code == 200
        body = resp.json()
        assert body["result"]["status"]["state"] == "TASK_STATE_WORKING"
        assert body["error"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_send_message_working_via_fakechat_ws_when_no_webhook():
    """S2 정정(2026-07-06): webhook 없는 멤버는 REJECTED가 아니라 fakechat WS(_broadcast)로
    전달 시도 후 WORKING — 플랫폼 기존 라우팅(webhook_targeting.py)과 동형 택일."""
    client, session, app = await _authed_client(uuid.uuid4())
    try:
        member = _mock_member()
        working_task = _mock_task("TASK_STATE_WORKING")

        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return _result(member)
            if call_count == 2:
                return _list_result([])  # webhook 없음
            return _result(working_task)

        session.execute = mock_execute
        session.flush = AsyncMock()
        session.commit = AsyncMock()

        with patch("app.routers.a2a.deliver_conversation_message_webhook", new_callable=AsyncMock) as mock_deliver, \
             patch("app.routers.a2a._broadcast", new_callable=AsyncMock) as mock_broadcast:
            async with client as c:
                resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=_SEND_REQ)
            mock_deliver.assert_not_called()
            mock_broadcast.assert_called_once()
            assert mock_broadcast.call_args[0][0] == str(MEMBER_ID)

        assert resp.status_code == 200
        body = resp.json()
        assert body["result"]["status"]["state"] == "TASK_STATE_WORKING"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_send_message_invalid_params_returns_jsonrpc_error():
    client, session, app = await _authed_client(uuid.uuid4())
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
    client, session, app = await _authed_client(uuid.uuid4())
    try:
        member = _mock_member()
        task_id = uuid.uuid4()
        task = MagicMock()
        task.id = task_id
        task.context_id = uuid.uuid4()
        task.state = "TASK_STATE_COMPLETED"
        task.artifacts = []
        task.history = []
        task.task_metadata = None
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
async def test_get_task_still_working_when_no_reply_yet():
    """S2: WORKING task는 thread에 아직 답신 없으면 그대로 WORKING(폴링만, 전이 없음)."""
    client, session, app = await _authed_client(uuid.uuid4())
    try:
        member = _mock_member()
        root_message_id = uuid.uuid4()
        working_task = _mock_task("TASK_STATE_WORKING", root_message_id=root_message_id)

        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return _result(member)
            if call_count == 2:
                return _result(working_task)
            return _result(None)  # thread 폴링 — 아직 답신 없음

        session.execute = mock_execute

        req = {"jsonrpc": "2.0", "id": 5, "method": "GetTask", "params": {"id": str(working_task.id)}}

        async with client as c:
            resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=req)

        body = resp.json()
        assert body["result"]["status"]["state"] == "TASK_STATE_WORKING"
        assert body["result"]["artifacts"] == []
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_task_completes_when_thread_reply_found():
    """S2 핵심: CC가 task-thread에 답신하면 GetTask 폴링이 그걸 발견해 COMPLETED+artifact로 전이."""
    client, session, app = await _authed_client(uuid.uuid4())
    try:
        member = _mock_member()
        root_message_id = uuid.uuid4()
        context_id = uuid.uuid4()
        working_task = _mock_task("TASK_STATE_WORKING", root_message_id=root_message_id, context_id=context_id)

        reply = MagicMock()
        reply.id = uuid.uuid4()
        reply.content = "QA status: all green, 0 open bugs."

        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return _result(member)
            if call_count == 2:
                return _result(working_task)
            return _result(reply)  # thread 폴링 — 답신 발견

        session.execute = mock_execute
        session.flush = AsyncMock()
        session.commit = AsyncMock()

        async def fake_refresh(obj):
            pass

        session.refresh = AsyncMock(side_effect=fake_refresh)

        req = {"jsonrpc": "2.0", "id": 6, "method": "GetTask", "params": {"id": str(working_task.id)}}

        async with client as c:
            resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=req)

        body = resp.json()
        assert body["result"]["status"]["state"] == "TASK_STATE_COMPLETED"
        assert body["result"]["artifacts"][0]["parts"][0]["text"] == "QA status: all green, 0 open bugs."
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_task_not_found_returns_a2a_error():
    client, session, app = await _authed_client(uuid.uuid4())
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
    client, session, app = await _authed_client(uuid.uuid4())
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


# ── P1-S2: /rpc auth 하드닝 + 완료신호 robustness ─────────────────────────────


@pytest.mark.anyio
async def test_rpc_requires_auth():
    """P1-S2(story 7b93eb10): /rpc는 action-triggering이라 authed(PO 크럭스)."""
    from app.main import app
    from app.dependencies.database import get_db

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    app.dependency_overrides[get_db] = override_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=_SEND_REQ)
        assert resp.status_code in (401, 403)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_rpc_cross_org_blocked():
    """P1-S2(A): caller org와 다른 org의 agent에게는 404(존재 여부 누설 없이 차단) —
    `_get_agent_member`에 org_id 검증 추가로 오늘 S20 클래스 IDOR 봉인."""
    client, session, app = await _authed_client(uuid.uuid4())
    try:
        session.execute = AsyncMock(return_value=_result(None))  # org_id 불일치 → 조회 0행

        async with client as c:
            resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=_SEND_REQ)

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_task_transitions_to_failed_on_delivery_failure():
    """P1-S2(B): 답신 없고 ConversationWebhookDelivery.status=="failed"면 타임아웃 전이라도
    즉시 FAILED(실제 아는 정보 우선)."""
    client, session, app = await _authed_client(uuid.uuid4())
    try:
        member = _mock_member()
        root_message_id = uuid.uuid4()
        working_task = _mock_task("TASK_STATE_WORKING", root_message_id=root_message_id)

        delivery = MagicMock()
        delivery.status = "failed"
        delivery.attempt_count = 3
        delivery.last_error = "connection refused"

        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return _result(member)
            if call_count == 2:
                return _result(working_task)
            if call_count == 3:
                return _result(None)  # thread 폴링 — 답신 없음
            return _result(delivery)  # webhook delivery 조회 — failed

        session.execute = mock_execute
        session.flush = AsyncMock()
        session.commit = AsyncMock()
        session.refresh = AsyncMock()

        req = {"jsonrpc": "2.0", "id": 7, "method": "GetTask", "params": {"id": str(working_task.id)}}

        async with client as c:
            resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=req)

        body = resp.json()
        assert body["result"]["status"]["state"] == "TASK_STATE_FAILED"
        assert "webhook delivery failed" in body["result"]["status"]["message"]["parts"][0]["text"]
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_task_transitions_to_failed_on_timeout():
    """P1-S2(B): delivery 실패 신호도 없고 생성 후 A2A_TASK_TIMEOUT_MINUTES 경과 시
    타임아웃 백스톱으로 FAILED(fakechat WS처럼 delivery 추적이 없는 경로의 유일한 실패 신호)."""
    import datetime as dt
    from app.routers.a2a import A2A_TASK_TIMEOUT_MINUTES

    client, session, app = await _authed_client(uuid.uuid4())
    try:
        member = _mock_member()
        root_message_id = uuid.uuid4()
        old_created_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=A2A_TASK_TIMEOUT_MINUTES + 1)
        working_task = _mock_task("TASK_STATE_WORKING", root_message_id=root_message_id, created_at=old_created_at)

        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return _result(member)
            if call_count == 2:
                return _result(working_task)
            return _result(None)  # 답신 없음 + delivery row 없음(fakechat 경로)

        session.execute = mock_execute
        session.flush = AsyncMock()
        session.commit = AsyncMock()
        session.refresh = AsyncMock()

        req = {"jsonrpc": "2.0", "id": 8, "method": "GetTask", "params": {"id": str(working_task.id)}}

        async with client as c:
            resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=req)

        body = resp.json()
        assert body["result"]["status"]["state"] == "TASK_STATE_FAILED"
        assert "timed out" in body["result"]["status"]["message"]["parts"][0]["text"]
    finally:
        app.dependency_overrides.clear()
