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


def _mock_persona(role_template_id: str | None = None) -> MagicMock:
    p = MagicMock()
    p.agent_id = MEMBER_ID
    p.name = "QA Engineer"
    p.slug = "qa"
    p.description = "QA testing role"
    p.config = {"tool_allowlist": ["stories", "tasks", "chat"]}
    if role_template_id is not None:
        p.config["role_template_id"] = role_template_id
    p.is_default = True
    p.deleted_at = None
    return p


def _mock_role_template(skills: list[dict]) -> MagicMock:
    rt = MagicMock()
    rt.skills = skills
    return rt


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


def _update_result(rowcount: int):
    """S-A1(story 2a57dc0f) CAS fix — `fail_task_if_still_working`가 실행하는 UPDATE 문의
    mock 결과. rowcount=1이면 이 호출이 전이시켰음(경쟁 없음), 0이면 이미 다른 경로가 전이."""
    r = MagicMock()
    r.rowcount = rowcount
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
async def test_agent_card_interface_url_uses_backend_direct_url_not_request_scheme():
    """버그/A2A P0(story 52bb1975): 인터페이스 url은 request.base_url(Cloud Run 뒤에서 프록시
    헤더 미신뢰 시 내부 스킴 http 노출)이 아니라 배포가 주입하는 FASTAPI_URL SSOT
    (resolve_backend_direct_url, MCP onboarding config와 동일 소스)로 구성돼야 한다 —
    테스트 클라이언트는 http://test로 요청해도 카드 url은 그 값을 반영하면 안 됨."""
    from app.routers import a2a as a2a_mod

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

        with patch.object(
            a2a_mod, "resolve_backend_direct_url",
            return_value="https://sprintable-backend-dev-57iommnikq-du.a.run.app",
        ):
            async with client as c:
                resp = await c.get(f"/api/v2/a2a/members/{MEMBER_ID}/agent-card.json")

        card = resp.json()
        url = card["supportedInterfaces"][0]["url"]
        assert url.startswith("https://sprintable-backend-dev-57iommnikq-du.a.run.app/")
        assert not url.startswith("http://test")
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_agent_card_prefers_role_template_skills_when_linked():
    """~300직군 카탈로그 S4: persona가 recruit_agent() 생성 marker(config.role_template_id)를
    가지면, 카드-빌드 시점에 그 role_template.skills(카탈로그 실시간 값)를 우선 반영 —
    persona 생성 시점 스냅샷(slug/tool_allowlist 파생 단일 skill)이 아니라."""
    client, session, app = await _client()
    try:
        rt_id = str(uuid.uuid4())
        member = _mock_member()
        persona = _mock_persona(role_template_id=rt_id)
        role_template = _mock_role_template(skills=[
            {"id": "qa", "name": "QA Engineer", "description": "품질 보증", "tags": ["qa", "testing"]},
            {"id": "automation", "name": "QA Automation", "description": "자동화", "tags": ["automation"]},
        ])

        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return _result(member)
            if call_count == 2:
                return _result(persona)
            return _result(role_template)

        session.execute = mock_execute

        async with client as c:
            resp = await c.get(f"/api/v2/a2a/members/{MEMBER_ID}/agent-card.json")

        assert resp.status_code == 200
        card = resp.json()
        # persona-slug 파생 단일 skill(id=qa, tags=tool_allowlist)이 아니라 카탈로그의 2-skill 그대로.
        assert len(card["skills"]) == 2
        assert card["skills"][0]["tags"] == ["qa", "testing"]
        assert card["skills"][1]["id"] == "automation"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_agent_card_falls_back_to_persona_when_role_template_skills_empty():
    """role_template_id는 있으나 그 role_template.skills가 아직 비어있으면(카탈로그 구조화
    미완료) persona-파생 단일 skill로 그레이스풀 폴백 — 빈 skills[] 노출 금지."""
    client, session, app = await _client()
    try:
        rt_id = str(uuid.uuid4())
        member = _mock_member()
        persona = _mock_persona(role_template_id=rt_id)
        role_template = _mock_role_template(skills=[])

        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return _result(member)
            if call_count == 2:
                return _result(persona)
            return _result(role_template)

        session.execute = mock_execute

        async with client as c:
            resp = await c.get(f"/api/v2/a2a/members/{MEMBER_ID}/agent-card.json")

        assert resp.status_code == 200
        card = resp.json()
        assert len(card["skills"]) == 1
        assert card["skills"][0]["id"] == "qa"
        assert card["skills"][0]["tags"] == ["stories", "tasks", "chat"]
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
               created_at=None, task_metadata=None, deadline_at=None) -> MagicMock:
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
    # S-A1(story 2a57dc0f): None(기본) = 레거시 행 시뮬레이션(effective_deadline이 created_at+
    # 타임아웃으로 폴백) — MagicMock() 기본 auto-attr(항상 not-None)에 datetime 비교 연산자가
    # TypeError 나는 걸 막는다. 명시 not-None 값을 넘기면 그 값을 deadline으로 그대로 사용.
    t.deadline_at = deadline_at
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
        assert body["result"]["task"]["status"]["state"] == "TASK_STATE_WORKING"
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
        assert body["result"]["task"]["status"]["state"] == "TASK_STATE_WORKING"
        assert body["error"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_send_message_working_via_sse_pipeline_when_no_webhook():
    """헤드라인 fix(2026-07-06, 문서 a2a-headline-sse-reroute-crux): webhook 없는 멤버는
    REJECTED가 아니라 Event/agent_gateway SSE 파이프라인(Event 생성→assign_recipient_seq→
    wake_agent)으로 전달 시도 후 WORKING — 죽은 ws_chat._broadcast 아님."""
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
             patch("app.routers.a2a.assign_recipient_seq", new_callable=AsyncMock, return_value=7) as mock_assign_seq, \
             patch("app.routers.a2a.wake_agent") as mock_wake_agent:
            async with client as c:
                resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=_SEND_REQ)
            mock_deliver.assert_not_called()
            mock_assign_seq.assert_called_once()
            mock_wake_agent.assert_called_once_with(str(MEMBER_ID), 7)

        assert resp.status_code == 200
        body = resp.json()
        assert body["result"]["task"]["status"]["state"] == "TASK_STATE_WORKING"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_send_message_response_wraps_task_in_spec_envelope():
    """버그(story 52bb1975 후속, 실 a2a-sdk E2E 적출): a2a.proto `SendMessageResponse`는
    bare Task가 아니라 oneof 래퍼(`{"task": {...}}`) — 안 씌우면 실 클라이언트 파서가
    "SendMessageResponse has no field named 'id'"로 깨짐(라이브 실측). result의 최상위 키가
    task의 필드(id/contextId 등)가 아니라 정확히 `task` 하나여야 한다."""
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
                return _list_result([])  # webhook 없음 → SSE 경로
            return _result(working_task)

        session.execute = mock_execute
        session.flush = AsyncMock()
        session.commit = AsyncMock()

        with patch("app.routers.a2a.deliver_conversation_message_webhook", new_callable=AsyncMock), \
             patch("app.routers.a2a.assign_recipient_seq", new_callable=AsyncMock, return_value=1), \
             patch("app.routers.a2a.wake_agent"):
            async with client as c:
                resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=_SEND_REQ)

        body = resp.json()
        assert set(body["result"].keys()) == {"task"}
        assert body["result"]["task"]["id"] == str(working_task.id)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_send_message_delivered_content_embeds_completion_protocol_hint():
    """근본 fix(story ebd5cf18, 문서 `a2a-task-completion-roundtrip-crux`, PO GO 2026-07-08):
    delegate에게 실제로 전달되는 content 자체에 완료 프로토콜(reply_thread_id=root_message_id·
    conversation_id) 힌트가 파싱 가능한 `key: value` 라인으로 박혀 있어야 한다 — 전달 채널
    (webhook/fakechat)과 무관하게 항상 도달(채널-불가지 fix)."""
    import re

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
                return _list_result([MEMBER_ID])  # webhook 있음
            return _result(working_task)

        session.execute = mock_execute
        session.flush = AsyncMock()
        session.commit = AsyncMock()

        with patch("app.routers.a2a.deliver_conversation_message_webhook", new_callable=AsyncMock) as mock_deliver:
            async with client as c:
                resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=_SEND_REQ)
            assert resp.status_code == 200

        delivered_content = mock_deliver.call_args.kwargs["content"]

        # session.add로 실제 생성된 Conversation/ConversationMessage에서 진짜 id를 뽑아 대조
        added = [c.args[0] for c in session.add.call_args_list]
        conv = next(o for o in added if type(o).__name__ == "Conversation")
        root_msg = next(o for o in added if type(o).__name__ == "ConversationMessage")

        assert f"reply_thread_id: {root_msg.id}" in delivered_content
        assert f"conversation_id: {conv.id}" in delivered_content
        assert "sprintable_send_chat_message" in delivered_content
        # 저장된 ConversationMessage.content 자체에도 동일 힌트가 있어야(채널 무관 단일 소스)
        assert root_msg.content == delivered_content
        # 원본 client 메시지 텍스트는 파싱 안전성을 위해 힌트와 정규식으로 분리 가능해야 함
        assert re.search(r"reply_thread_id: [0-9a-f-]{36}", delivered_content)
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
            if call_count == 3:
                return _result(None)  # thread 폴링 — 아직 답신 없음
            return _list_result([])  # delivery row 없음

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
    """P1-S2(B): 답신 없고 전 ConversationWebhookDelivery.status=="failed"면 타임아웃 전이라도
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
            if call_count == 4:
                return _list_result([delivery])  # webhook delivery 조회 — 1건, 전량 failed
            return _update_result(1)  # CAS UPDATE(fail_task_if_still_working) — 경쟁 없음

        async def mock_refresh(obj):
            # S-A1(story 2a57dc0f) CAS fix — 실 DB라면 refresh()가 CAS UPDATE 결과(FAILED)를
            # 반영한다. mock 세션은 그 UPDATE를 실행 안 하므로 refresh 시점에 동등 효과 시뮬레이션.
            obj.state = "TASK_STATE_FAILED"
            obj.task_metadata = {
                **(obj.task_metadata or {}),
                "failure_reason": "webhook delivery failed on all 1 channel(s) after 3 attempts: connection refused",
            }
            obj.artifacts = [*obj.artifacts, {
                "artifactId": "x", "name": "failure-reason",
                "parts": [{"text": "webhook delivery failed on all 1 channel(s) after 3 attempts: connection refused"}],
            }]

        session.execute = mock_execute
        session.flush = AsyncMock()
        session.commit = AsyncMock()
        session.refresh = mock_refresh

        req = {"jsonrpc": "2.0", "id": 7, "method": "GetTask", "params": {"id": str(working_task.id)}}

        async with client as c:
            resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=req)

        body = resp.json()
        assert body["result"]["status"]["state"] == "TASK_STATE_FAILED"
        assert "webhook delivery failed" in body["result"]["status"]["message"]["parts"][0]["text"]
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_task_not_failed_when_one_of_multiple_webhook_deliveries_succeeds():
    """까심 크로스모델 QA(story 652c2842, task bd4a6c0b 재현): multi-webhook 멤버가 채널 2개 중
    하나만 실패해도 "최신 1건"이 그 실패행이면 거짓 FAILED가 났던 버그. 전량 실패일 때만 FAILED로
    승격해야 하며, 하나라도 delivered면 이 판정에서는 FAILED로 전이하지 않는다(WORKING 유지)."""
    client, session, app = await _authed_client(uuid.uuid4())
    try:
        member = _mock_member()
        root_message_id = uuid.uuid4()
        working_task = _mock_task("TASK_STATE_WORKING", root_message_id=root_message_id)

        delivered = MagicMock()
        delivered.status = "delivered"
        delivered.attempt_count = 1
        delivered.last_error = None

        failed = MagicMock()
        failed.status = "failed"
        failed.attempt_count = 3
        failed.last_error = "connection refused"

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
            # webhook delivery 조회 — 최신순 2건(가장 최신이 failed여도 다른 채널은 delivered)
            return _list_result([failed, delivered])

        session.execute = mock_execute
        session.flush = AsyncMock()
        session.commit = AsyncMock()
        session.refresh = AsyncMock()

        req = {"jsonrpc": "2.0", "id": 9, "method": "GetTask", "params": {"id": str(working_task.id)}}

        async with client as c:
            resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=req)

        body = resp.json()
        assert body["result"]["status"]["state"] == "TASK_STATE_WORKING"
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
            if call_count == 3:
                return _result(None)  # thread 폴링 — 답신 없음
            if call_count == 4:
                return _list_result([])  # delivery row 없음(fakechat 경로)
            return _update_result(1)  # CAS UPDATE(fail_task_if_still_working) — 경쟁 없음

        async def mock_refresh(obj):
            # S-A1(story 2a57dc0f) CAS fix — 실 DB라면 refresh()가 CAS UPDATE 결과(FAILED)를
            # 반영한다. mock 세션은 그 UPDATE를 실행 안 하므로 refresh 시점에 동등 효과 시뮬레이션.
            reason = f"timed out waiting for agent response after {A2A_TASK_TIMEOUT_MINUTES}m"
            obj.state = "TASK_STATE_FAILED"
            obj.task_metadata = {**(obj.task_metadata or {}), "failure_reason": reason}
            obj.artifacts = [*obj.artifacts, {
                "artifactId": "x", "name": "failure-reason", "parts": [{"text": reason}],
            }]

        session.execute = mock_execute
        session.flush = AsyncMock()
        session.commit = AsyncMock()
        session.refresh = mock_refresh

        req = {"jsonrpc": "2.0", "id": 8, "method": "GetTask", "params": {"id": str(working_task.id)}}

        async with client as c:
            resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=req)

        body = resp.json()
        assert body["result"]["status"]["state"] == "TASK_STATE_FAILED"
        assert "timed out" in body["result"]["status"]["message"]["parts"][0]["text"]
    finally:
        app.dependency_overrides.clear()


# ── E-A2A-PROTO P0(2026-07-06): 스펙 정합 필드 회귀 lock ──────────────────────


def test_agent_capabilities_has_extensions_field_defaults_empty():
    from app.schemas.a2a import AgentCapabilities

    caps = AgentCapabilities(streaming=False, push_notifications=False, extended_agent_card=False)
    assert caps.extensions == []
    dumped = caps.model_dump(by_alias=True, mode="json")
    assert dumped["extensions"] == []
    assert dumped["pushNotifications"] is False
    assert dumped["extendedAgentCard"] is False


def test_agent_extension_roundtrip_camelcase():
    from app.schemas.a2a import AgentExtension

    ext = AgentExtension(uri="https://example.com/ext/v1", description="test ext", required=True, params={"k": "v"})
    dumped = ext.model_dump(by_alias=True, mode="json")
    assert dumped == {"uri": "https://example.com/ext/v1", "description": "test ext", "required": True, "params": {"k": "v"}}


def test_message_has_extensions_and_reference_task_ids_fields():
    from app.schemas.a2a import Message, Part

    msg = Message(
        message_id="m1", role="ROLE_USER", parts=[Part(text="hi")],
        extensions=["https://example.com/ext/v1"], reference_task_ids=["t1", "t2"],
    )
    dumped = msg.model_dump(by_alias=True, mode="json")
    assert dumped["extensions"] == ["https://example.com/ext/v1"]
    assert dumped["referenceTaskIds"] == ["t1", "t2"]
    # 기본값(누락 시) — 회귀 없이 빈 리스트
    msg2 = Message(message_id="m2", role="ROLE_USER", parts=[Part(text="hi")])
    assert msg2.extensions == []
    assert msg2.reference_task_ids == []


def test_part_has_raw_and_metadata_fields():
    from app.schemas.a2a import Part

    part = Part(raw="base64data==", metadata={"k": "v"})
    dumped = part.model_dump(by_alias=True, mode="json")
    assert dumped["raw"] == "base64data=="
    assert dumped["metadata"] == {"k": "v"}
    # text 전용 Part는 raw/metadata가 None이어도 무방(oneof 성격)
    text_part = Part(text="hi")
    assert text_part.raw is None
    assert text_part.metadata is None


def test_artifact_has_metadata_and_extensions_fields():
    from app.schemas.a2a import Artifact, Part

    artifact = Artifact(
        artifact_id="a1", parts=[Part(text="result")],
        metadata={"k": "v"}, extensions=["https://example.com/ext/v1"],
    )
    dumped = artifact.model_dump(by_alias=True, mode="json")
    assert dumped["metadata"] == {"k": "v"}
    assert dumped["extensions"] == ["https://example.com/ext/v1"]
    # 기본값 회귀 없음
    artifact2 = Artifact(artifact_id="a2", parts=[Part(text="result")])
    assert artifact2.metadata is None
    assert artifact2.extensions == []


# ── E-A2A-PROTO P1(2026-07-06): A2A-Version 헤더 + ListTasks ──────────────────


@pytest.mark.anyio
async def test_rpc_accepts_matching_a2a_version_header():
    client, session, app = await _authed_client(uuid.uuid4())
    try:
        member = _mock_member()
        session.execute = AsyncMock(return_value=_result(member))

        async with client as c:
            resp = await c.post(
                f"/api/v2/a2a/members/{MEMBER_ID}/rpc",
                json={"jsonrpc": "2.0", "id": 1, "method": "UnknownMethod", "params": {}},
                headers={"A2A-Version": "1.0"},
            )
        body = resp.json()
        # 버전 통과 후 정상적으로 method-not-found까지 도달(버전 게이트에서 안 막힘)
        assert body["error"]["code"] == -32601
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_rpc_rejects_unsupported_a2a_version_major():
    client, session, app = await _authed_client(uuid.uuid4())
    try:
        async with client as c:
            resp = await c.post(
                f"/api/v2/a2a/members/{MEMBER_ID}/rpc",
                json={"jsonrpc": "2.0", "id": 1, "method": "SendMessage", "params": {}},
                headers={"A2A-Version": "2.0"},
            )
        body = resp.json()
        assert body["error"]["code"] == -32009
        assert "Unsupported A2A-Version" in body["error"]["message"]
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_rpc_allows_missing_a2a_version_header_lenient():
    """PoC→Phase1 tradeoff(문서화됨): 헤더 부재는 관대하게 허용 — 기존 dogfood 트래픽 무회귀."""
    client, session, app = await _authed_client(uuid.uuid4())
    try:
        member = _mock_member()
        session.execute = AsyncMock(return_value=_result(member))

        async with client as c:
            resp = await c.post(
                f"/api/v2/a2a/members/{MEMBER_ID}/rpc",
                json={"jsonrpc": "2.0", "id": 1, "method": "UnknownMethod", "params": {}},
            )
        body = resp.json()
        assert body["error"]["code"] == -32601  # 버전 게이트 안 걸림, method-not-found까지 도달
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_tasks_returns_paginated_tasks_scoped_to_member():
    client, session, app = await _authed_client(uuid.uuid4())
    try:
        member = _mock_member()
        t1 = _mock_task("TASK_STATE_COMPLETED")
        t2 = _mock_task("TASK_STATE_WORKING")

        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return _result(member)
            if call_count == 2:
                return _result(2)  # total_size count
            return _list_result([t1, t2])

        session.execute = mock_execute

        req = {"jsonrpc": "2.0", "id": 1, "method": "ListTasks", "params": {}}
        async with client as c:
            resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=req)

        body = resp.json()
        assert body["error"] is None
        assert len(body["result"]["tasks"]) == 2
        assert body["result"]["totalSize"] == 2
        assert body["result"]["pageSize"] == 50
        assert body["result"]["nextPageToken"] == ""
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_tasks_next_page_token_when_more_results():
    client, session, app = await _authed_client(uuid.uuid4())
    try:
        member = _mock_member()
        t1 = _mock_task("TASK_STATE_COMPLETED")

        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return _result(member)
            if call_count == 2:
                return _result(5)  # total_size larger than returned page
            return _list_result([t1])

        session.execute = mock_execute

        req = {"jsonrpc": "2.0", "id": 1, "method": "ListTasks", "params": {"pageSize": 1}}
        async with client as c:
            resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=req)

        body = resp.json()
        assert body["result"]["nextPageToken"] == "1"
        assert body["result"]["pageSize"] == 1
    finally:
        app.dependency_overrides.clear()


# ── E-A2A-EXT(2026-07-06): project-context extension(profile, opt-in) ────────


from app.routers.a2a import PROJECT_CONTEXT_EXTENSION_URI  # noqa: E402


def _send_req_with_project_context(context: dict) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "SendMessage",
        "params": {
            "message": {
                "messageId": str(uuid.uuid4()),
                "role": "ROLE_USER",
                "parts": [{"text": "please check the QA status"}],
                "metadata": {PROJECT_CONTEXT_EXTENSION_URI: context},
            }
        },
    }


@pytest.mark.anyio
async def test_project_context_extension_preserved_when_declared_no_webhook():
    """A2A-Extensions 헤더로 선언 + Message.metadata에 컨텍스트 있으면 task_metadata와
    fakechat Event payload 양쪽에 보존된다."""
    client, session, app = await _authed_client(uuid.uuid4())
    try:
        member = _mock_member()
        working_task = _mock_task("TASK_STATE_WORKING")
        context = {"project_id": "proj-1", "story_id": "story-1", "acceptance_criteria": ["AC1"]}

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
        added_objects = []
        session.add = MagicMock(side_effect=lambda obj: added_objects.append(obj))

        with patch("app.routers.a2a.assign_recipient_seq", new_callable=AsyncMock, return_value=7), \
             patch("app.routers.a2a.wake_agent"):
            async with client as c:
                resp = await c.post(
                    f"/api/v2/a2a/members/{MEMBER_ID}/rpc",
                    json=_send_req_with_project_context(context),
                    headers={"A2A-Extensions": PROJECT_CONTEXT_EXTENSION_URI},
                )

        assert resp.status_code == 200
        body = resp.json()
        assert body["error"] is None

        from app.models.a2a_task import A2ATask
        from app.models.event import Event

        a2a_task_obj = next(o for o in added_objects if isinstance(o, A2ATask))
        assert a2a_task_obj.task_metadata["project_context"] == context
        assert a2a_task_obj.task_metadata["activated_extensions"] == [PROJECT_CONTEXT_EXTENSION_URI]

        event_obj = next(o for o in added_objects if isinstance(o, Event))
        assert event_obj.payload["project_context"] == context
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_project_context_extension_ignored_when_not_declared():
    """헤더 미선언 시 Message.metadata에 컨텍스트가 있어도 완전히 무시된다(무회귀 opt-in)."""
    client, session, app = await _authed_client(uuid.uuid4())
    try:
        member = _mock_member()
        working_task = _mock_task("TASK_STATE_WORKING")
        context = {"project_id": "proj-1"}

        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return _result(member)
            if call_count == 2:
                return _list_result([])
            return _result(working_task)

        session.execute = mock_execute
        session.flush = AsyncMock()
        session.commit = AsyncMock()
        added_objects = []
        session.add = MagicMock(side_effect=lambda obj: added_objects.append(obj))

        with patch("app.routers.a2a.assign_recipient_seq", new_callable=AsyncMock, return_value=7), \
             patch("app.routers.a2a.wake_agent"):
            async with client as c:
                # A2A-Extensions 헤더 없음
                resp = await c.post(
                    f"/api/v2/a2a/members/{MEMBER_ID}/rpc",
                    json=_send_req_with_project_context(context),
                )

        assert resp.status_code == 200
        from app.models.a2a_task import A2ATask
        from app.models.event import Event

        a2a_task_obj = next(o for o in added_objects if isinstance(o, A2ATask))
        assert "project_context" not in a2a_task_obj.task_metadata
        assert "activated_extensions" not in a2a_task_obj.task_metadata

        event_obj = next(o for o in added_objects if isinstance(o, Event))
        assert "project_context" not in event_obj.payload
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_agent_card_advertises_project_context_extension():
    client, session, app = await _client()
    try:
        member = _mock_member()
        persona = _mock_persona()

        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return _result(member)
            return _result(persona)

        session.execute = mock_execute

        async with client as c:
            resp = await c.get(f"/api/v2/a2a/members/{MEMBER_ID}/agent-card.json")

        body = resp.json()
        extensions = body["capabilities"]["extensions"]
        assert len(extensions) == 1
        assert extensions[0]["uri"] == PROJECT_CONTEXT_EXTENSION_URI
        assert extensions[0]["required"] is False
    finally:
        app.dependency_overrides.clear()


# ── E-A2A-EXTERNAL(축4, 2026-07-06): securitySchemes 정직 광고 ────────────────


@pytest.mark.anyio
async def test_agent_card_advertises_bearer_security_scheme():
    client, session, app = await _client()
    try:
        member = _mock_member()
        persona = _mock_persona()

        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return _result(member)
            return _result(persona)

        session.execute = mock_execute

        async with client as c:
            resp = await c.get(f"/api/v2/a2a/members/{MEMBER_ID}/agent-card.json")

        body = resp.json()
        schemes = body["securitySchemes"]
        assert len(schemes) == 1
        key = next(iter(schemes))
        http_auth = schemes[key]["httpAuthSecurityScheme"]
        assert http_auth["scheme"] == "Bearer"

        requirements = body["securityRequirements"]
        assert len(requirements) == 1
        assert key in requirements[0]["schemes"]
    finally:
        app.dependency_overrides.clear()


# ── HITL crux(story 7726a003) — INPUT_REQUIRED reader ─────────────────────────

@pytest.mark.anyio
async def test_get_task_input_required_when_linked_gate_pending():
    """AC(Q2 reader): WORKING task + task_metadata.linked_gate_id가 pending Gate를 가리키면
    reply-thread 폴링 전에 INPUT_REQUIRED로 단락(폴링 스킵 — delivery/timeout 로직 미도달)."""
    client, session, app = await _authed_client(uuid.uuid4())
    try:
        member = _mock_member()
        gate_id = uuid.uuid4()
        task = _mock_task("TASK_STATE_WORKING", task_metadata={"linked_gate_id": str(gate_id)})
        gate = MagicMock()
        gate.status = "pending"

        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return _result(member)
            if call_count == 2:
                return _result(task)
            if call_count == 3:
                return _result(gate)
            raise AssertionError("reply-thread 폴링까지 도달하면 안 됨(INPUT_REQUIRED 단락 실패)")

        session.execute = mock_execute

        req = {"jsonrpc": "2.0", "id": 6, "method": "GetTask", "params": {"id": str(task.id)}}

        async with client as c:
            resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=req)

        body = resp.json()
        assert body["result"]["status"]["state"] == "TASK_STATE_INPUT_REQUIRED"
        assert call_count == 3
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_task_working_continues_when_linked_gate_not_pending():
    """linked_gate_id가 있어도 Gate.status != 'pending'(예: approved)이면 정상 reply-thread
    폴링 경로로 폴백 — 무회귀(WORKING 유지, 아직 답신 없으면)."""
    client, session, app = await _authed_client(uuid.uuid4())
    try:
        member = _mock_member()
        gate_id = uuid.uuid4()
        root_message_id = uuid.uuid4()
        task = _mock_task(
            "TASK_STATE_WORKING", root_message_id=root_message_id,
            task_metadata={"linked_gate_id": str(gate_id)},
        )
        gate = MagicMock()
        gate.status = "approved"

        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return _result(member)
            if call_count == 2:
                return _result(task)
            if call_count == 3:
                return _result(gate)
            if call_count == 4:
                return _result(None)  # thread 폴링 — 아직 답신 없음
            return _list_result([])  # delivery row 없음

        session.execute = mock_execute

        req = {"jsonrpc": "2.0", "id": 7, "method": "GetTask", "params": {"id": str(task.id)}}

        async with client as c:
            resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=req)

        body = resp.json()
        assert body["result"]["status"]["state"] == "TASK_STATE_WORKING"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_task_input_required_state_persists_without_regate_check():
    """이미 INPUT_REQUIRED인 task는 재판정 없이 그대로 반환 — 복귀는 transition_gate()
    전담(여기서 낙관적으로 되돌리지 않음). Gate 재조회/reply-thread 폴링 모두 안 함."""
    client, session, app = await _authed_client(uuid.uuid4())
    try:
        member = _mock_member()
        task = _mock_task(
            "TASK_STATE_INPUT_REQUIRED",
            task_metadata={"linked_gate_id": str(uuid.uuid4())},
        )

        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return _result(member)
            if call_count == 2:
                return _result(task)
            raise AssertionError("INPUT_REQUIRED 재진입 시 추가 쿼리 발생하면 안 됨")

        session.execute = mock_execute

        req = {"jsonrpc": "2.0", "id": 8, "method": "GetTask", "params": {"id": str(task.id)}}

        async with client as c:
            resp = await c.post(f"/api/v2/a2a/members/{MEMBER_ID}/rpc", json=req)

        body = resp.json()
        assert body["result"]["status"]["state"] == "TASK_STATE_INPUT_REQUIRED"
        assert call_count == 2
    finally:
        app.dependency_overrides.clear()
