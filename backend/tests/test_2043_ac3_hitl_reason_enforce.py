"""story #2043 AC3: 고위험 HITL 승인의 사유 서버측 강제.

배경: "고위험 승인은 사유 없이 통과 못 한다 — 서버가 거부하고, 화면은 그 응답을 사람 말로 옮긴다"는
게이트(story #2027, `gates.py::transition_gate_endpoint`)에는 있었지만 HitlRequest 승인 경로
(`PATCH /hitl/requests/{id}`)에는 없었다 — #2058이 human-only 불변식에서 찾은 것과 같은 형태
(같은 승인 사실에 두 구현·한쪽만 강제)의 재발.

스코프: `request_type == "gate_approval"`(#2054/#2058과 동일 — Gate와 같은 병목에서 충돌하는
파킹분만) + `hitl_metadata.work_type`이 있는 경우만. Gate의 `derive_risk_grade(posture, gate_type)`를
그대로 재사용(work_type을 그 자리에 대입) — "merge"는 두 체계에서 문자 그대로 같은 개념이라
새 정책을 만들지 않는다. posture가 conservative/미설정(balanced 폴백)이면 미분류 work_type
(예: "done")도 안전판(보수적 high)으로 떨어진다는 것까지 명시적으로 실증한다.

seed 패턴은 test_2027_gate_approval_reason_enforce.py / test_2058_hitl_human_only.py와 동형.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    import app.models  # noqa: F401 — 전 모델 메타데이터 로드
    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, org_id, project_id, user_id):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(
            user_id=str(user_id), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}},
        )

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


async def _seed_org_project_human(session, *, posture: str | None):
    from app.models.hitl_config import OrgGatePolicy
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    if posture is not None:
        session.add(OrgGatePolicy(org_id=org.id, posture=posture))
        await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    user = User(id=uuid.uuid4(), email=f"h-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user.id, role="member")
    session.add(om)
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=om.id, permission="granted", role="member",
    ))
    await session.commit()

    return {"org_id": org.id, "project_id": project.id, "user_id": user.id}


async def _seed_hitl_request(session, *, org_id, project_id, work_type=None, request_type="gate_approval"):
    from app.models.hitl import HitlRequest

    metadata = {"work_item_id": str(uuid.uuid4())}
    if work_type is not None:
        metadata["work_type"] = work_type
    req = HitlRequest(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, agent_id=uuid.uuid4(),
        request_type=request_type, title="t", prompt="p", requested_for=uuid.uuid4(),
        status="pending", hitl_metadata=metadata,
    )
    session.add(req)
    await session.commit()
    return req.id


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_high_risk_merge_approve_without_reason_422_no_mutation():
    """conservative posture(1차 축)면 work_type 무관 high — 사유 없이 approve → 422·상태 미변경."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_human(s, posture="conservative")
            req_id = await _seed_hitl_request(
                s, org_id=seeded["org_id"], project_id=seeded["project_id"], work_type="merge",
            )

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"], seeded["user_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(f"/api/v2/hitl/requests/{req_id}", json={"status": "approved"})
            assert resp.status_code == 422, resp.text
            assert "사유" in resp.json()["error"]["message"], resp.json()

            recheck = await client.get("/api/v2/hitl/requests", params={"status": "pending"})
            assert recheck.status_code == 200, recheck.text
            ids = {row["id"] for row in recheck.json()["data"]}
            assert str(req_id) in ids, "422 이후에도 여전히 pending이어야 함(뮤테이션 0)"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_high_risk_merge_approve_with_reason_persists():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_human(s, posture="conservative")
            req_id = await _seed_hitl_request(
                s, org_id=seeded["org_id"], project_id=seeded["project_id"], work_type="merge",
            )

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"], seeded["user_id"])
        client = _client_for(app)
        try:
            reason = "PR diff 전체 확인, CI green, 마이그레이션 없음 확인 후 승인"
            resp = await client.patch(
                f"/api/v2/hitl/requests/{req_id}",
                json={"status": "approved", "response_text": reason},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["data"]["status"] == "approved", resp.json()

            recheck = await client.get("/api/v2/hitl/requests", params={"status": "approved"})
            ids = {row["id"]: row for row in recheck.json()["data"]}
            assert str(req_id) in ids
            assert ids[str(req_id)]["response_text"] == reason
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_permissive_posture_downgrades_merge_to_low_no_reason_needed():
    """permissive posture(1차 축)가 work_type=merge(2차 축이면 high)를 오버라이드 — 저위험이라
    사유 없이도 200(과도 강제 금지, Gate 쪽 test_2027과 동일 원칙)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_human(s, posture="permissive")
            req_id = await _seed_hitl_request(
                s, org_id=seeded["org_id"], project_id=seeded["project_id"], work_type="merge",
            )

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"], seeded["user_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(f"/api/v2/hitl/requests/{req_id}", json={"status": "approved"})
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_unclassified_work_type_falls_back_to_high_safety_net():
    """posture 미설정(balanced 폴백) + work_type='done'(2차 축 어느 집합에도 없음) → derive_risk_grade의
    보수적 high 안전판이 적용돼 사유가 강제된다는 것을 명시적으로 실증(doc §2.3 폴백)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_human(s, posture=None)
            req_id = await _seed_hitl_request(
                s, org_id=seeded["org_id"], project_id=seeded["project_id"], work_type="done",
            )

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"], seeded["user_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(f"/api/v2/hitl/requests/{req_id}", json={"status": "approved"})
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_non_gate_approval_request_type_out_of_scope_no_enforcement():
    """request_type != 'gate_approval'(수동 HITL 등, #2054/#2058과 동일 스코프 경계)은 이 강제
    대상이 아니다 — 사유 없어도 200(과잉 확장 금지)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_human(s, posture="conservative")
            req_id = await _seed_hitl_request(
                s, org_id=seeded["org_id"], project_id=seeded["project_id"],
                work_type="merge", request_type="approval",
            )

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"], seeded["user_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(f"/api/v2/hitl/requests/{req_id}", json={"status": "approved"})
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_rejected_status_never_requires_reason():
    """approved만 사유를 요구한다 — rejected는 risk_grade 무관 기존대로 사유 없이 통과(Gate 쪽
    관례와 동형: void/reject류는 이 강제의 대상이 아니었다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_human(s, posture="conservative")
            req_id = await _seed_hitl_request(
                s, org_id=seeded["org_id"], project_id=seeded["project_id"], work_type="merge",
            )

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"], seeded["user_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(f"/api/v2/hitl/requests/{req_id}", json={"status": "rejected"})
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
