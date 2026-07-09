"""E-A2A-완성 S-A3(story 6d0454c3): linked_gate 선언 writer — 실 Postgres 검증.

reader(``_handle_get_task`` linked_gate_id 체크)와 복귀 트리거(``transition_gate`` 3번째
분기)는 이미 구현 — 이 테스트는 그 둘이 기다리던 유일한 writer(`POST .../tasks/{id}/link-gate`)
가 정확히 배선됐는지만 검증한다. story 8236bbc3 컨벤션: create_all 자체 스키마 관리."""
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


async def _seed(session, *, task_state="TASK_STATE_WORKING"):
    from sqlalchemy import text as _text
    from app.models.a2a_task import A2ATask
    from app.models.gate import Gate

    org_id = uuid.uuid4()
    delegate_id = uuid.uuid4()
    other_agent_id = uuid.uuid4()

    await session.execute(_text("SET session_replication_role = replica"))
    task = A2ATask(
        id=uuid.uuid4(), context_id=uuid.uuid4(), root_message_id=uuid.uuid4(),
        member_id=delegate_id, state=task_state, history=[], artifacts=[], task_metadata={},
    )
    gate = Gate(
        id=uuid.uuid4(), org_id=org_id, work_item_id=uuid.uuid4(), work_item_type="story",
        gate_type="pr_review", status="pending",
    )
    other_org_gate = Gate(
        id=uuid.uuid4(), org_id=uuid.uuid4(), work_item_id=uuid.uuid4(), work_item_type="story",
        gate_type="pr_review", status="pending",
    )
    session.add_all([task, gate, other_org_gate])
    await session.commit()
    return org_id, delegate_id, other_agent_id, task, gate, other_org_gate


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
async def test_delegate_can_link_gate_to_own_working_task():
    from app.main import app
    from app.models.a2a_task import A2ATask
    from sqlalchemy import select

    engine, Session = await _session()
    try:
        async with Session() as s:
            org_id, delegate_id, _other, task, gate, _other_gate = await _seed(s)

        await _override_deps(app, Session, user_id=delegate_id, org_id=org_id)
        try:
            async with _client_for(app) as c:
                resp = await c.post(
                    f"/api/v2/a2a/tasks/{task.id}/link-gate", json={"gate_id": str(gate.id)},
                )
            assert resp.status_code == 200
            # S-A5(story c140977f): 응답에 "reason" 키 추가(additive) — 미지정 시 None.
            assert resp.json() == {
                "linked": True, "task_id": str(task.id), "gate_id": str(gate.id), "reason": None,
            }

            async with Session() as s:
                reloaded = (await s.execute(select(A2ATask).where(A2ATask.id == task.id))).scalar_one()
                assert reloaded.task_metadata["linked_gate_id"] == str(gate.id)
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_other_agent_cannot_link_gate_to_someone_elses_task():
    from app.main import app

    engine, Session = await _session()
    try:
        async with Session() as s:
            org_id, _delegate, other_agent_id, task, gate, _og = await _seed(s)

        await _override_deps(app, Session, user_id=other_agent_id, org_id=org_id)
        try:
            async with _client_for(app) as c:
                resp = await c.post(
                    f"/api/v2/a2a/tasks/{task.id}/link-gate", json={"gate_id": str(gate.id)},
                )
            assert resp.status_code == 403
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_link_rejects_gate_from_a_different_org():
    from app.main import app

    engine, Session = await _session()
    try:
        async with Session() as s:
            org_id, delegate_id, _other, task, _gate, other_org_gate = await _seed(s)

        await _override_deps(app, Session, user_id=delegate_id, org_id=org_id)
        try:
            async with _client_for(app) as c:
                resp = await c.post(
                    f"/api/v2/a2a/tasks/{task.id}/link-gate", json={"gate_id": str(other_org_gate.id)},
                )
            assert resp.status_code == 404  # 타 org gate — IDOR 차단(org 스코프 조회가 못 찾음)
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_link_rejects_non_working_task():
    from app.main import app

    engine, Session = await _session()
    try:
        async with Session() as s:
            org_id, delegate_id, _other, task, gate, _og = await _seed(s, task_state="TASK_STATE_COMPLETED")

        await _override_deps(app, Session, user_id=delegate_id, org_id=org_id)
        try:
            async with _client_for(app) as c:
                resp = await c.post(
                    f"/api/v2/a2a/tasks/{task.id}/link-gate", json={"gate_id": str(gate.id)},
                )
            assert resp.status_code == 400
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_link_404s_on_unknown_task():
    from app.main import app

    engine, Session = await _session()
    try:
        org_id = uuid.uuid4()
        user_id = uuid.uuid4()
        await _override_deps(app, Session, user_id=user_id, org_id=org_id)
        try:
            async with _client_for(app) as c:
                resp = await c.post(
                    f"/api/v2/a2a/tasks/{uuid.uuid4()}/link-gate", json={"gate_id": str(uuid.uuid4())},
                )
            assert resp.status_code == 404
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_end_to_end_full_hitl_roundtrip_via_real_gate_service():
    """[실증] AC2 축소판(모듈 내부 함수 직접 호출로): 실 create_gate()(disposition 해소 포함,
    system default=ask→pending) → link-gate 엔드포인트 → reader(GetTask)가 INPUT_REQUIRED로
    승격 → transition_gate(사람 승인) → WORKING 복귀. HTTP 라운드트립은 별도 실 SDK 스크립트로
    보강(scratchpad)."""
    from app.main import app
    from app.models.a2a_task import A2ATask
    from app.models.team import TeamMember
    from app.services.gate_service import create_gate, transition_gate
    from sqlalchemy import select, text as _text

    engine, Session = await _session()
    try:
        org_id = uuid.uuid4()
        project_id = uuid.uuid4()
        delegate_id = uuid.uuid4()
        role_id = uuid.uuid4()
        approver_id = uuid.uuid4()

        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            delegate_member = TeamMember(
                id=delegate_id, org_id=org_id, project_id=project_id, type="agent",
                name="SA3 E2E Delegate", role="member", is_active=True,
            )
            task = A2ATask(
                id=uuid.uuid4(), context_id=uuid.uuid4(), root_message_id=uuid.uuid4(),
                member_id=delegate_id, state="TASK_STATE_WORKING", history=[], artifacts=[],
                task_metadata={},
            )
            s.add_all([delegate_member, task])
            await s.commit()
            task_id = task.id

            gate = await create_gate(
                s, org_id=org_id, work_item_id=uuid.uuid4(), work_item_type="story",
                gate_type="pr_review", member_id=delegate_id, role_id=role_id,
            )
            assert gate.status == "pending"  # system default(ask) — HITL 필요 케이스 확認
            await s.commit()
            gate_id = gate.id

        # ── writer: delegate가 자기 task에 gate 링크 선언(실 HTTP 엔드포인트 경유) ──────
        await _override_deps(app, Session, user_id=delegate_id, org_id=org_id)
        try:
            async with _client_for(app) as c:
                link_resp = await c.post(
                    f"/api/v2/a2a/tasks/{task_id}/link-gate", json={"gate_id": str(gate_id)},
                )
            assert link_resp.status_code == 200
        finally:
            app.dependency_overrides.clear()

        # ── reader: GetTask JSON-RPC가 INPUT_REQUIRED로 단락하는지 ────────────────────
        await _override_deps(app, Session, user_id=delegate_id, org_id=org_id)
        try:
            async with _client_for(app) as c:
                get_resp = await c.post(
                    f"/api/v2/a2a/members/{delegate_id}/rpc",
                    json={"jsonrpc": "2.0", "id": 1, "method": "GetTask", "params": {"id": str(task_id)}},
                )
            get_body = get_resp.json()
            assert get_body["result"]["status"]["state"] == "TASK_STATE_INPUT_REQUIRED"
        finally:
            app.dependency_overrides.clear()

        # ── 사람 승인 → transition_gate(기존 구현, Q3) → WORKING 복귀 ─────────────────
        async with Session() as s:
            await transition_gate(s, org_id, gate_id, "approved", resolver_id=approver_id)
            await s.commit()

        async with Session() as s:
            reloaded = (await s.execute(select(A2ATask).where(A2ATask.id == task_id))).scalar_one()
            assert reloaded.state == "TASK_STATE_WORKING"
    finally:
        await engine.dispose()
