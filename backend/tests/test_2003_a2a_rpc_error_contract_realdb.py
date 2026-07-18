"""story #2003(Phase B P1-a, E-A2A-PROTO 리라이어빌리티): `/rpc`(JSON-RPC 2.0 엔드포인트)의
에러 계약 통일 검증 — 실 PG(alembic-migrated, `team_members` VIEW 필요·8236bbc3
destructive_schema 컨벤션 아님, `test_a2a_sa8_multiproject_member_scope_realdb.py`와 동일
패턴).

Root cause: `_get_agent_member`(a2a.py:196)의 404·`get_verified_org_id`/`get_current_user`
Depends의 401/403은 `a2a_rpc` 자신의 try/except **밖**(dependency 단계·핸들러 조기 호출)에서
발생해 main.py의 글로벌 예외 핸들러로 이스케이프 → 그 핸들러가 REST 엔벨로프
(`{"data":None,"error":{...},"meta":None}`)를 그대로 렌더해 스펙 준수 JSON-RPC 클라이언트가
파싱 불가했다. main.py의 두 글로벌 핸들러가 `is_a2a_rpc_path`로 `/rpc` 요청만 정밀 매치해
JSON-RPC envelope(`{"jsonrpc":"2.0","id":...,"error":{"code":int,"message":str,
"data":{"retryable":bool}}}`)을 대신 렌더하도록 고쳤다 — 이 파일은 그 축 전부(auth 실패·
agent-not-found·미처리 예외) + 기존 in-handler JSON-RPC 에러(invalid params) 무회귀 +
`get_agent_card`(REST 계약 유지 필수 라우트) 비회귀 + 경로-분기 자체의 mutation self-check를
검증한다."""
from __future__ import annotations

import os
import uuid
from unittest.mock import patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(
        not _REAL_DB_URL,
        reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요 — alembic upgrade heads 적용된 DB(team_members VIEW)",
    ),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    """S-A8 선례와 동일 격리 조치 — anyio 테스트마다 새 이벤트루프가 뜨는데 `app.core.database`의
    모듈-전역 engine은 첫 테스트의 루프에 바인딩된 채 남아 다음 테스트(다른 루프)에서 asyncpg가
    cross-loop RuntimeError를 낸다. 각 테스트 뒤 전역 풀을 폐기."""
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_agent(session):
    """단일-project agent 1명 + 소속 org/project — 이 파일의 전 테스트가 공유하는 최소 시드."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    org = Organization(id=uuid.uuid4(), name="S2003 Org", slug=f"s2003-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="S2003 Project")
    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="S2003 Agent", is_active=True)
    session.add_all([project, agent])
    await session.commit()

    grant = ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted", role="member",
    )
    session.add(grant)
    await session.commit()
    return org.id, project.id, agent.id


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    # raise_app_exceptions=False: Starlette의 ServerErrorMiddleware는 `@app.exception_handler
    # (Exception)`이 응답을 이미 만들어 보낸 뒤에도 원본 예외를 항상 재-raise한다(ASGI 서버
    # 로그 가시성을 위한 표준 동작) — 강제 unhandled 500 테스트가 그 재-raise를 pytest 실패로
    # 오인하지 않도록 여기서 억제하고 실제 렌더된 JSONResponse만 검사한다.
    return AsyncClient(
        transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test",
    )


async def _authed_overrides(app, org_id: uuid.UUID, caller_id: uuid.UUID | None = None):
    """S-A8 선례와 동일 — 유효 인증(caller org=agent org)으로 오버라이드."""
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id

    async def _auth():
        return AuthContext(
            user_id=str(caller_id or uuid.uuid4()), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    async def _org():
        return org_id

    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


_SEND_MESSAGE_REQ_TEMPLATE = {
    "jsonrpc": "2.0", "id": "1", "method": "SendMessage",
    "params": {"message": {
        "messageId": str(uuid.uuid4()), "role": "ROLE_USER",
        "parts": [{"text": "s2003 test"}],
    }},
}


# ── AC1: auth 실패 (missing/invalid token) ─────────────────────────────────────


@pytest.mark.anyio
async def test_rpc_auth_failure_returns_jsonrpc_envelope():
    """Authorization 헤더 없음 → get_current_user Depends가 endpoint body 진입 前 401 raise
    (`a2a_rpc`의 try/except 밖) → main.py 글로벌 HTTPException 핸들러가 /rpc 경로 매치해
    JSON-RPC envelope으로 렌더해야 한다. REST 엔벨로프 필드(문자열 code)가 전혀 섞이면 안 됨."""
    from app.main import app
    from app.dependencies.database import get_db

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            _org_id, _project_id, agent_id = await _seed_agent(s)

        async def _db():
            async with Session() as s:
                yield s

        app.dependency_overrides[get_db] = _db
        # get_current_user/get_verified_org_id는 의도적으로 오버라이드하지 않음 — 실 인증
        # 경로(Authorization 헤더 없음 → 401)를 그대로 태운다.

        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/a2a/members/{agent_id}/rpc",
                json=_SEND_MESSAGE_REQ_TEMPLATE,
            )
            assert resp.status_code == 200, resp.text  # in-handler JSON-RPC 에러와 동일 컨벤션
            body = resp.json()
            assert body["jsonrpc"] == "2.0"
            assert body.get("result") is None
            assert "id" in body  # null이어도 키 자체는 존재(JSON-RPC §5)
            error = body["error"]
            assert isinstance(error["code"], int), error  # REST 문자열 코드("UNAUTHORIZED") 아님
            assert error["code"] == -32010
            assert isinstance(error["message"], str) and error["message"]
            assert error["data"]["retryable"] is False
            assert "data" not in body or "error" not in (body.get("data") or {})  # REST data 필드 유입 없음
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── AC2: agent not found (valid auth, nonexistent/wrong-org member_id) ────────


@pytest.mark.anyio
async def test_rpc_agent_not_found_returns_jsonrpc_envelope():
    """유효 인증이지만 존재하지 않는 member_id → `_get_agent_member`의 HTTPException(404)이
    `a2a_rpc`의 try/except 밖에서 raise돼 이스케이프 → JSON-RPC envelope(-32011)으로 렌더."""
    from app.main import app
    from app.dependencies.database import get_db

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id, _agent_id = await _seed_agent(s)

        async def _db():
            async with Session() as s:
                yield s

        app.dependency_overrides[get_db] = _db
        await _authed_overrides(app, org_id)

        client = _client_for(app)
        try:
            nonexistent_member_id = uuid.uuid4()
            resp = await client.post(
                f"/api/v2/a2a/members/{nonexistent_member_id}/rpc",
                json=_SEND_MESSAGE_REQ_TEMPLATE,
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["jsonrpc"] == "2.0"
            assert body["id"] == "1"  # body가 파싱 가능했으므로 real id 스레딩(null 폴백 아님)
            error = body["error"]
            assert isinstance(error["code"], int)
            assert error["code"] == -32011
            assert error["data"]["retryable"] is False
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_rpc_agent_wrong_org_returns_jsonrpc_envelope_not_leak():
    """cross-org(IDOR 축, P1-S2/S-A8 선례): caller org와 다른 org의 agent → 존재 유무 누설
    없이 동일 -32011로 차단(회귀 아님 — 판정 자체는 불변, 렌더 형식만 바뀜)."""
    from app.main import app
    from app.dependencies.database import get_db

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            _org_id, _project_id, agent_id = await _seed_agent(s)
        other_org_id = uuid.uuid4()

        async def _db():
            async with Session() as s:
                yield s

        app.dependency_overrides[get_db] = _db
        await _authed_overrides(app, other_org_id)  # agent의 org와 다른 org로 인증

        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/a2a/members/{agent_id}/rpc",
                json=_SEND_MESSAGE_REQ_TEMPLATE,
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["error"]["code"] == -32011
            assert body["error"]["data"]["retryable"] is False
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── AC3: 강제 unhandled 500 ─────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_rpc_unhandled_exception_returns_standard_internal_error():
    """메소드 핸들러가 plain 미처리 예외를 던지면(방어 코드가 못 잡는 진짜 버그 시뮬레이션)
    main.py `unhandled_exception_handler`가 /rpc 경로 매치해 JSON-RPC **표준** Internal error
    (-32603, 스펙 §7 — 커스텀 번호 아님) + retryable=True로 렌더해야 한다."""
    from app.main import app
    from app.dependencies.database import get_db
    from app.routers import a2a as a2a_mod

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id, agent_id = await _seed_agent(s)

        async def _db():
            async with Session() as s:
                yield s

        app.dependency_overrides[get_db] = _db
        await _authed_overrides(app, org_id)

        async def _boom(*_args, **_kwargs):
            raise RuntimeError("s2003 forced unhandled failure")

        client = _client_for(app)
        try:
            with patch.dict(a2a_mod._METHODS, {"SendMessage": _boom}):
                resp = await client.post(
                    f"/api/v2/a2a/members/{agent_id}/rpc",
                    json=_SEND_MESSAGE_REQ_TEMPLATE,
                )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["jsonrpc"] == "2.0"
            error = body["error"]
            assert isinstance(error["code"], int)
            assert error["code"] == -32603  # JSON-RPC 2.0 표준 코드(스펙 §7) — 커스텀 번호 아님
            assert error["data"]["retryable"] is True  # 5xx 분류
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── AC4: invalid params(기존 _JsonRpcException 경로) 재검증 — 무회귀 ────────────


@pytest.mark.anyio
async def test_rpc_invalid_params_still_in_handler_jsonrpc_error_unaffected():
    """`_JsonRpcException`(핸들러 body 안, `a2a_rpc`의 자체 try/except가 잡는 경로)은 이번
    변경이 손대지 않은 축 — 여전히 200 + error.code=-32602(INVALID_PARAMS)로 정상 동작해야
    한다(글로벌 핸들러 경로-분기와 완전히 독립적인 기존 계약)."""
    from app.main import app
    from app.dependencies.database import get_db

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id, agent_id = await _seed_agent(s)

        async def _db():
            async with Session() as s:
                yield s

        app.dependency_overrides[get_db] = _db
        await _authed_overrides(app, org_id)

        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/a2a/members/{agent_id}/rpc",
                json={"jsonrpc": "2.0", "id": "1", "method": "SendMessage", "params": {}},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["error"]["code"] == -32602
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── AC5: get_agent_card REST 계약 비회귀 ────────────────────────────────────────


@pytest.mark.anyio
async def test_get_agent_card_rest_contract_unchanged_for_nonexistent_member():
    """`GET /members/{id}/agent-card.json`(SEC-S2로 authed+same-org, `_get_agent_member`를
    `/rpc`와 공유 호출) — 존재하지 않는 member_id는 여전히 **REST 엔벨로프**
    (`{"data":None,"error":{"code":"NOT_FOUND",...},"meta":None}`)여야 한다. `is_a2a_rpc_path`가
    이 라우트(`.../agent-card.json`)를 매치하지 않으므로 회귀 없음이 정밀 경로 매치의
    핵심 증거."""
    from app.main import app
    from app.dependencies.database import get_db

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id, _agent_id = await _seed_agent(s)

        async def _db():
            async with Session() as s:
                yield s

        app.dependency_overrides[get_db] = _db
        await _authed_overrides(app, org_id)

        client = _client_for(app)
        try:
            nonexistent_member_id = uuid.uuid4()
            resp = await client.get(f"/api/v2/a2a/members/{nonexistent_member_id}/agent-card.json")
            assert resp.status_code == 404, resp.text
            body = resp.json()
            assert body == {
                "data": None,
                "error": {"code": "NOT_FOUND", "message": "Agent not found"},
                "meta": None,
            }
            assert "jsonrpc" not in body  # JSON-RPC envelope 유입 없음(경로 정밀 매치 증거)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── AC6: mutation self-check — 경로-분기가 실제로 load-bearing인지 ─────────────


@pytest.mark.anyio
async def test_mutation_self_check_path_branch_is_load_bearing():
    """경로-분기(`is_a2a_rpc_path`)를 무력화하면(monkeypatch로 항상 False — 실제 소스를
    편집해 되돌리는 대신, 그 분기가 참조하는 판정 함수 자체를 끈다: main.py 핸들러가
    호출하는 지점은 동일하게 유지하면서 판정 결과만 뒤집는다) RED(REST 엔벨로프로 회귀)가
    재현되고, 되돌리면(monkeypatch 해제) GREEN(JSON-RPC envelope)으로 복귀해야 한다 —
    이 테스트 없이는 `is_a2a_rpc_path`가 실제로 아무것도 안 해도(예: 상수 True/False로
    박제) 다른 테스트가 우연히 통과할 여지가 있었다는 증거를 남긴다."""
    from app.main import app
    from app.dependencies.database import get_db
    from app.routers import a2a as a2a_mod

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            _org_id, _project_id, agent_id = await _seed_agent(s)

        async def _db():
            async with Session() as s:
                yield s

        app.dependency_overrides[get_db] = _db
        # 인증 미오버라이드 — 실 401 경로.

        client = _client_for(app)
        try:
            # RED: 경로-분기를 무력화하면 옛 REST 엔벨로프로 회귀해야 한다.
            with patch.object(a2a_mod, "is_a2a_rpc_path", return_value=False):
                red_resp = await client.post(
                    f"/api/v2/a2a/members/{agent_id}/rpc", json=_SEND_MESSAGE_REQ_TEMPLATE,
                )
            assert red_resp.status_code == 401, red_resp.text
            red_body = red_resp.json()
            assert red_body["error"]["code"] == "UNAUTHORIZED"  # REST 문자열 코드(JSON-RPC 아님)
            assert "jsonrpc" not in red_body

            # GREEN: monkeypatch 해제 → 정상 JSON-RPC envelope 복귀.
            green_resp = await client.post(
                f"/api/v2/a2a/members/{agent_id}/rpc", json=_SEND_MESSAGE_REQ_TEMPLATE,
            )
            assert green_resp.status_code == 200, green_resp.text
            green_body = green_resp.json()
            assert green_body["jsonrpc"] == "2.0"
            assert green_body["error"]["code"] == -32010
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
