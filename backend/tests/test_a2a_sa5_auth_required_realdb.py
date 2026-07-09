"""E-A2A-완성 S-A5(story c140977f): AUTH_REQUIRED — auth 변형 명시 선언, 실 Postgres 검증.

S-A3의 `link-gate` writer에 `reason="auth"` 옵션을 얹은 변형 — reader
(``_advance_task_state``)가 그 reason을 보고 INPUT_REQUIRED 대신 AUTH_REQUIRED로 전이시키고,
복귀 트리거(``transition_gate``)가 AUTH_REQUIRED에서도 WORKING/REJECTED로 되돌린다. 자동
감지는 크럭스가 명시 배제(실신호 0) — 이 writer의 명시 선언만이 유일한 유효 신호원.
story 8236bbc3 컨벤션: create_all 자체 스키마 관리."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed(session):
    from sqlalchemy import text as _text
    from app.models.a2a_task import A2ATask
    from app.models.gate import Gate
    from app.models.team import TeamMember

    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    delegate_id = uuid.uuid4()

    await session.execute(_text("SET session_replication_role = replica"))
    member = TeamMember(
        id=delegate_id, org_id=org_id, project_id=project_id, type="agent",
        name="SA5 Delegate", role="member", is_active=True,
    )
    task = A2ATask(
        id=uuid.uuid4(), context_id=uuid.uuid4(), root_message_id=uuid.uuid4(),
        member_id=delegate_id, state="TASK_STATE_WORKING", history=[], artifacts=[],
        task_metadata={},
    )
    gate = Gate(
        id=uuid.uuid4(), org_id=org_id, work_item_id=uuid.uuid4(), work_item_type="story",
        gate_type="pr_review", status="pending",
    )
    session.add_all([member, task, gate])
    await session.commit()
    return org_id, delegate_id, task, gate


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _override_deps(app, Session, *, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            yield s

    async def _auth():
        return AuthContext(user_id=str(user_id), email=None, claims={})

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


@pytest.mark.anyio
async def test_link_gate_with_reason_auth_transitions_to_auth_required_not_input_required():
    from app.main import app
    from app.models.a2a_task import A2ATask
    from sqlalchemy import select

    engine, Session = await _session()
    try:
        async with Session() as s:
            org_id, delegate_id, task, gate = await _seed(s)

        await _override_deps(app, Session, user_id=delegate_id, org_id=org_id)
        try:
            async with _client_for(app) as c:
                link_resp = await c.post(
                    f"/api/v2/a2a/tasks/{task.id}/link-gate",
                    json={"gate_id": str(gate.id), "reason": "auth"},
                )
            assert link_resp.status_code == 200
            assert link_resp.json()["reason"] == "auth"

            async with _client_for(app) as c:
                get_resp = await c.post(
                    f"/api/v2/a2a/members/{delegate_id}/rpc",
                    json={"jsonrpc": "2.0", "id": 1, "method": "GetTask", "params": {"id": str(task.id)}},
                )
            body = get_resp.json()
            assert body["result"]["status"]["state"] == "TASK_STATE_AUTH_REQUIRED"
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_link_gate_without_reason_still_yields_input_required_regression_check():
    """S-A3 기존 동작(reason 미지정=INPUT_REQUIRED) 회귀 0 재확認."""
    from app.main import app

    engine, Session = await _session()
    try:
        async with Session() as s:
            org_id, delegate_id, task, gate = await _seed(s)

        await _override_deps(app, Session, user_id=delegate_id, org_id=org_id)
        try:
            async with _client_for(app) as c:
                link_resp = await c.post(
                    f"/api/v2/a2a/tasks/{task.id}/link-gate", json={"gate_id": str(gate.id)},
                )
            assert link_resp.status_code == 200
            assert link_resp.json()["reason"] is None

            async with _client_for(app) as c:
                get_resp = await c.post(
                    f"/api/v2/a2a/members/{delegate_id}/rpc",
                    json={"jsonrpc": "2.0", "id": 1, "method": "GetTask", "params": {"id": str(task.id)}},
                )
            assert get_resp.json()["result"]["status"]["state"] == "TASK_STATE_INPUT_REQUIRED"
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_link_gate_rejects_unsupported_reason_value():
    from app.main import app

    engine, Session = await _session()
    try:
        async with Session() as s:
            org_id, delegate_id, task, gate = await _seed(s)

        await _override_deps(app, Session, user_id=delegate_id, org_id=org_id)
        try:
            async with _client_for(app) as c:
                resp = await c.post(
                    f"/api/v2/a2a/tasks/{task.id}/link-gate",
                    json={"gate_id": str(gate.id), "reason": "not-a-real-reason"},
                )
            assert resp.status_code == 400
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_full_auth_required_roundtrip_declare_resolve_working_completed():
    """[실증] AC2 축소판: 선언(auth)→AUTH_REQUIRED→해소(approve)→WORKING→(답신)→COMPLETED."""
    from app.main import app
    from app.models.a2a_task import A2ATask
    from app.models.conversation import ConversationMessage
    from app.services.gate_service import transition_gate
    from sqlalchemy import select

    engine, Session = await _session()
    try:
        async with Session() as s:
            org_id, delegate_id, task, gate = await _seed(s)
            task_id, gate_id = task.id, gate.id

        await _override_deps(app, Session, user_id=delegate_id, org_id=org_id)
        try:
            async with _client_for(app) as c:
                link_resp = await c.post(
                    f"/api/v2/a2a/tasks/{task_id}/link-gate",
                    json={"gate_id": str(gate_id), "reason": "auth"},
                )
            assert link_resp.status_code == 200

            async with _client_for(app) as c:
                get1 = await c.post(
                    f"/api/v2/a2a/members/{delegate_id}/rpc",
                    json={"jsonrpc": "2.0", "id": 1, "method": "GetTask", "params": {"id": str(task_id)}},
                )
            assert get1.json()["result"]["status"]["state"] == "TASK_STATE_AUTH_REQUIRED"
        finally:
            app.dependency_overrides.clear()

        # 사람이 크리덴셜 해소 후 approve.
        async with Session() as s:
            await transition_gate(s, org_id, gate_id, "approved", resolver_id=uuid.uuid4())
            await s.commit()

        async with Session() as s:
            reloaded = (await s.execute(select(A2ATask).where(A2ATask.id == task_id))).scalar_one()
            assert reloaded.state == "TASK_STATE_WORKING"
            # 답신 도착 시뮬레이션 — 기존 reply-thread 폴링이 COMPLETED까지 캐리.
            s.add(ConversationMessage(
                id=uuid.uuid4(), conversation_id=reloaded.context_id, sender_id=None,
                content="credential resolved, task done", thread_id=reloaded.root_message_id,
                created_at=datetime.now(timezone.utc),
            ))
            await s.commit()

        await _override_deps(app, Session, user_id=delegate_id, org_id=org_id)
        try:
            async with _client_for(app) as c:
                get2 = await c.post(
                    f"/api/v2/a2a/members/{delegate_id}/rpc",
                    json={"jsonrpc": "2.0", "id": 2, "method": "GetTask", "params": {"id": str(task_id)}},
                )
            assert get2.json()["result"]["status"]["state"] == "TASK_STATE_COMPLETED"
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reject_from_auth_required_transitions_to_rejected():
    from app.main import app
    from app.models.a2a_task import A2ATask
    from app.services.gate_service import transition_gate
    from sqlalchemy import select

    engine, Session = await _session()
    try:
        async with Session() as s:
            org_id, delegate_id, task, gate = await _seed(s)
            task_id, gate_id = task.id, gate.id

        await _override_deps(app, Session, user_id=delegate_id, org_id=org_id)
        try:
            async with _client_for(app) as c:
                await c.post(
                    f"/api/v2/a2a/tasks/{task_id}/link-gate",
                    json={"gate_id": str(gate_id), "reason": "auth"},
                )
            async with _client_for(app) as c:
                await c.post(
                    f"/api/v2/a2a/members/{delegate_id}/rpc",
                    json={"jsonrpc": "2.0", "id": 1, "method": "GetTask", "params": {"id": str(task_id)}},
                )
        finally:
            app.dependency_overrides.clear()

        async with Session() as s:
            await transition_gate(s, org_id, gate_id, "rejected", resolver_id=uuid.uuid4())
            await s.commit()

        async with Session() as s:
            reloaded = (await s.execute(select(A2ATask).where(A2ATask.id == task_id))).scalar_one()
            assert reloaded.state == "TASK_STATE_REJECTED"
    finally:
        await engine.dispose()
