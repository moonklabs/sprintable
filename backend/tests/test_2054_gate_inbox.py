"""story #2054: 결재함(Gate) + HITL 승인 대기(HitlRequest) 통합 인박스 ``GET /api/v2/gates/inbox``.

배경: `Gate`(``/gates``·`/gates/[id]` 화면)와 `HitlRequest`(``enforce_gate()``가 파킹·
``/organization/workforce/hitl`` 화면)가 같은 승인 병목(merge/done)에서 각각 독립적으로 발동하는데
서로를 못 봐서, 사람이 한쪽 화면만 보고 승인했다고 믿어도 다른 쪽 대기가 남아 있을 수 있었다.
오르테가 판정: 데이터모델은 안 합치고(Gate 미러 생성 금지) **read-layer만** 통합 — 액션은 각자
native API로(``PATCH /gates/{id}/transition`` vs ``PATCH /hitl/requests/{id}``).

미르코(FE)와 합의한 계약(conversation eaa1b6cb-5d73-4019-bca8-7e320087f827):
  - 페이지네이션 없음(기존 ``GET /gates`` 관례 그대로).
  - 기본 정렬 ``created_at DESC``(두 출처 통일).
  - ``sort=urgency``는 Gate 쪽 기존 SLA/held 로직 그대로 + HitlRequest는 age(created_at)만으로
    같은 정렬축에 best-effort로 끼워 넣는다(HitlRequest엔 SLA/held 개념이 없어 완전 동형은 아님 —
    미리 합의된 단순화).
  - 각 항목 ``source: "gate"|"hitl"``로 FE가 액션 라우팅.

스코프: HitlRequest 쪽은 ``request_type == "gate_approval"``(gate_enforce.py 파킹분)만 — 그 외
수동 HITL 승인 요청은 #2054 스코프 밖(Gate와 동일 병목에서 충돌하는 것만 통합).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# realdb 섹션이 Base.metadata.create_all 을 호출한다 — conftest.py AST 가드(story 8236bbc3) 대응.
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


async def _setup_app(app, Session, org_id, user_id):
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
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {}})

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


async def _seed_org_project_users(session):
    """org + project + 2명(A: project owner grant, B: project member grant) — test_1974 선례 재사용."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.commit()

    user_a = User(id=uuid.uuid4(), email=f"a-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    user_b = User(id=uuid.uuid4(), email=f"b-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add_all([user_a, user_b])
    await session.commit()

    om_a = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user_a.id, role="member")
    om_b = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user_b.id, role="member")
    session.add_all([om_a, om_b])
    await session.commit()

    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=om_a.id,
        permission="granted", role="owner",
    ))
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=om_b.id,
        permission="granted", role="member",
    ))
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id,
        "user_a_id": user_a.id, "user_b_id": user_b.id,
        "org_member_a_id": om_a.id, "org_member_b_id": om_b.id,
    }


def _hitl_request(*, org_id, project_id, work_item_id, work_type="merge", status="pending",
                   request_type="gate_approval", created_at=None):
    from app.models.hitl import HitlRequest

    return HitlRequest(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id,
        agent_id=uuid.uuid4(), request_type=request_type,
        title="승인 필요: merge", prompt="merge 전이에 사람 승인이 필요합니다.",
        requested_for=uuid.uuid4(), status=status,
        hitl_metadata={"work_item_id": str(work_item_id), "work_type": work_type},
        created_at=created_at or datetime.now(timezone.utc),
    )


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_inbox_combines_gate_and_hitl_sources():
    """Gate 1건 + HitlRequest(gate_approval) 1건이 같은 응답에 source 로 구분돼 함께 나온다."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_users(s)
            org_id, project_id, a_id = seeded["org_id"], seeded["project_id"], seeded["user_a_id"]

            story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="s1")
            s.add(story)
            await s.flush()
            gate = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story.id, work_item_type="story",
                gate_type="merge", status="pending",
            )
            s.add(gate)

            story2 = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="s2")
            s.add(story2)
            await s.flush()
            hitl = _hitl_request(org_id=org_id, project_id=project_id, work_item_id=story2.id)
            s.add(hitl)
            await s.commit()

        await _setup_app(app, Session, org_id, a_id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/gates/inbox")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            by_id = {row["id"]: row for row in body}
            assert str(gate.id) in by_id
            assert str(hitl.id) in by_id
            assert by_id[str(gate.id)]["source"] == "gate"
            assert by_id[str(hitl.id)]["source"] == "hitl"
            assert by_id[str(hitl.id)]["status"] == "pending"
            assert by_id[str(hitl.id)]["requires_human"] is True
            assert by_id[str(hitl.id)]["work_item_id"] == str(story2.id)
            assert by_id[str(hitl.id)]["work_type"] == "merge"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_inbox_excludes_non_gate_approval_hitl_requests():
    """request_type != 'gate_approval' 인 HitlRequest(수동 승인 등)는 #2054 스코프 밖 — 인박스에 안 뜬다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_users(s)
            org_id, project_id, a_id = seeded["org_id"], seeded["project_id"], seeded["user_a_id"]

            other = _hitl_request(
                org_id=org_id, project_id=project_id, work_item_id=uuid.uuid4(),
                request_type="approval",
            )
            s.add(other)
            await s.commit()

        await _setup_app(app, Session, org_id, a_id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/gates/inbox")
            assert resp.status_code == 200, resp.text
            ids = {row["id"] for row in resp.json()}
            assert str(other.id) not in ids
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_inbox_status_filter_applies_to_both_sources():
    from app.main import app
    from app.models.gate import Gate
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_users(s)
            org_id, project_id, a_id = seeded["org_id"], seeded["project_id"], seeded["user_a_id"]

            story_pending = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="pending")
            story_approved = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="approved")
            s.add_all([story_pending, story_approved])
            await s.flush()
            gate_pending = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story_pending.id, work_item_type="story",
                gate_type="merge", status="pending",
            )
            gate_approved = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story_approved.id, work_item_type="story",
                gate_type="merge", status="approved", resolver_id=uuid.uuid4(),
            )
            s.add_all([gate_pending, gate_approved])

            hitl_pending = _hitl_request(
                org_id=org_id, project_id=project_id, work_item_id=uuid.uuid4(), status="pending",
            )
            hitl_approved = _hitl_request(
                org_id=org_id, project_id=project_id, work_item_id=uuid.uuid4(), status="approved",
            )
            s.add_all([hitl_pending, hitl_approved])
            await s.commit()

        await _setup_app(app, Session, org_id, a_id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/gates/inbox", params={"status": "pending"})
            assert resp.status_code == 200, resp.text
            ids = {row["id"] for row in resp.json()}
            assert ids == {str(gate_pending.id), str(hitl_pending.id)}
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_inbox_default_sort_created_at_desc_across_sources():
    """정렬 미지정 시 created_at DESC — Gate/HitlRequest 출처 무관 단일 시계열로 섞여야 한다."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_users(s)
            org_id, project_id, a_id = seeded["org_id"], seeded["project_id"], seeded["user_a_id"]

            story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="s1")
            s.add(story)
            await s.flush()

            now = datetime.now(timezone.utc)
            gate_old = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story.id, work_item_type="story",
                gate_type="merge", status="pending", created_at=now - timedelta(minutes=30),
            )
            hitl_mid = _hitl_request(
                org_id=org_id, project_id=project_id, work_item_id=uuid.uuid4(),
                created_at=now - timedelta(minutes=20),
            )
            gate_new = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story.id, work_item_type="story",
                gate_type="qa", status="pending", created_at=now - timedelta(minutes=5),
            )
            s.add_all([gate_old, hitl_mid, gate_new])
            await s.commit()

        await _setup_app(app, Session, org_id, a_id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/gates/inbox")
            assert resp.status_code == 200, resp.text
            ids_in_order = [row["id"] for row in resp.json()]
            assert ids_in_order == [str(gate_new.id), str(hitl_mid.id), str(gate_old.id)]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_inbox_assigned_to_me_filters_both_sources():
    """assigned_to_me=true: A(project owner grant)는 두 출처 모두 자격 있는 항목이 보이고,
    B(project member grant)는 둘 다 배제(project-role 불가)된다 — WHO 판정을 Gate와 동일 규칙으로
    HitlRequest(work_item_id=story) 에도 적용."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_users(s)
            org_id, project_id = seeded["org_id"], seeded["project_id"]
            a_id, b_id = seeded["user_a_id"], seeded["user_b_id"]

            story_g = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="s-gate")
            story_h = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="s-hitl")
            s.add_all([story_g, story_h])
            await s.flush()

            gate = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story_g.id, work_item_type="story",
                gate_type="merge", status="pending",
            )
            hitl = _hitl_request(org_id=org_id, project_id=project_id, work_item_id=story_h.id)
            s.add_all([gate, hitl])
            await s.commit()

        # A: project owner grant → 둘 다 보임.
        await _setup_app(app, Session, org_id, a_id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/gates/inbox", params={"assigned_to_me": "true"})
            assert resp.status_code == 200, resp.text
            ids_a = {row["id"] for row in resp.json()}
            assert ids_a == {str(gate.id), str(hitl.id)}
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        # B: project member grant(승인 불가) → 둘 다 배제, 빈 목록.
        await _setup_app(app, Session, org_id, b_id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/gates/inbox", params={"assigned_to_me": "true"})
            assert resp.status_code == 200, resp.text
            assert resp.json() == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_inbox_urgency_sort_interleaves_hitl_by_age():
    """sort=urgency: HitlRequest는 SLA/held 개념이 없어 age(created_at ASC) 축으로만 Gate 사이에
    끼워진다 — 오래된(더 나이든) 항목이 상위(먼저)로 온다는 age 성분만 최소 실증."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_users(s)
            org_id, project_id, a_id = seeded["org_id"], seeded["project_id"], seeded["user_a_id"]

            story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="s1")
            s.add(story)
            await s.flush()

            now = datetime.now(timezone.utc)
            hitl_older = _hitl_request(
                org_id=org_id, project_id=project_id, work_item_id=uuid.uuid4(),
                created_at=now - timedelta(hours=2),
            )
            gate_newer = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story.id, work_item_type="story",
                gate_type="merge", status="pending", created_at=now - timedelta(minutes=5),
            )
            s.add_all([hitl_older, gate_newer])
            await s.commit()

        await _setup_app(app, Session, org_id, a_id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/gates/inbox", params={"sort": "urgency"})
            assert resp.status_code == 200, resp.text
            ids_in_order = [row["id"] for row in resp.json()]
            # 둘 다 non-held·age 축 비교 대상 — 더 오래된 hitl_older가 앞선다.
            assert ids_in_order == [str(hitl_older.id), str(gate_newer.id)]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
