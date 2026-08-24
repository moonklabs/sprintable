"""story #2975 AC4(PO 확定 2026-08-24) — 게이트 결재 이력 감사 표면. 2026-08-23 두 실사고의
근본 미스터리를 새 `GET /gates/{id}/activity`로 실제 재현+해소하는 양성대조:

미스터리①(PR#3402): PO가 승인 취소(5분 창)를 눌렀는데, 그게 서버에 반영됐는지 판별 불가했다.
→ approve→undo 시퀀스를 만들고, 새 엔드포인트가 「누가 언제 취소했는지」를 실제로 보여주는지.

미스터리②(PR#3406): 어떤 SHA에 approved 이벤트가 떴는데 그 승인의 actor가 누구였는지 판별
불가했다. → approve 시퀀스를 만들고, 새 엔드포인트가 actor_name까지 정확히 해석하는지.

부수: void_gate(이전엔 logger.info뿐 — DB 미기록)·override_gate(line-less 시 neutral_facts만,
mutable이라 감사 불가)도 이제 ActivityLog에 남아 같은 표면에서 조회되는지."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema

_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.activity_log  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, org_id, user_id):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from tests.conftest import override_db_and_read

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

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


async def _seed_common(session, *, email_prefix: str = "po", org_role: str = "member"):
    """org_role — is_org_owner_or_admin(void 엔드포인트 인가)이 org_members.role을 직접 보므로
    void 테스트는 'owner'|'admin' 필요. approve/undo는 project_access role(owner)로 충분."""
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

    # User 모델엔 name 필드가 없다(member_resolver.py 실측 — OrgMember의 display name은
    # user.email 배치 조회로 대체된다) — email에 식별 가능한 prefix를 심어 actor_name 대조.
    user = User(id=uuid.uuid4(), email=f"{email_prefix}-{uuid.uuid4().hex[:8]}@test.com",
                hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user.id, role=org_role)
    session.add(om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=om.id,
        permission="granted", role="owner",
    ))
    await session.commit()

    return {"org_id": org.id, "project_id": project.id, "user_id": user.id,
            "member_id": om.id, "email": user.email}


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_approve_then_undo_answers_mystery1_was_cancel_applied():
    """미스터리① 양성대조 — approve→undo 시퀀스가 새 엔드포인트에 시간순으로 둘 다 뜨는가.
    실사고에서 판별 불가했던 「PO 취소가 서버에 반영됐나」를 이제 조회로 답할 수 있어야 한다."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.pm import Story
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    SHA = "sha-mystery1-2eadc1f44"

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s, email_prefix="po")
            story = Story(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                title="#2975 AC4 미스터리① 재현",
            )
            s.add(story)
            await s.commit()
            gate = Gate(
                id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id, work_item_type="story",
                gate_type=MERGE_GATE_TYPE, status="pending",
                approved_head_sha=None, github_check_run_id=1, github_check_run_sha=SHA,
            )
            s.add(gate)
            await s.commit()
            gate_id = gate.id

        await _setup_app(app, Session, seeded["org_id"], seeded["user_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{gate_id}/transition",
                json={"status": "approved", "note": "테스트 승인", "evidence_viewed": True,
                      "reviewed_head_sha": SHA},
            )
            assert resp.status_code == 200, resp.text

            resp = await client.post(f"/api/v2/gates/{gate_id}/undo")
            assert resp.status_code == 200, resp.text

            resp = await client.get(f"/api/v2/gates/{gate_id}/activity")
            assert resp.status_code == 200, resp.text
            items = resp.json()
            actions = [i["action"] for i in items]
            # created_at.desc() — 최신(undo)이 먼저.
            assert actions[:2] == ["gate_resolution_undone", "gate_approved"], actions

            undo_item = items[0]
            assert undo_item["actor_name"], "취소한 사람 이름이 조회돼야 미스터리①이 실제로 풀림"
            assert undo_item["context"]["previous_status"] == "approved"
            assert undo_item["context"]["previous_approved_head_sha"] == SHA, (
                "무엇이(어느 SHA가) 취소됐는지도 남아야 한다"
            )

            approve_item = items[1]
            assert approve_item["actor_name"], "승인한 사람 이름도 조회돼야 함(미스터리② 동형)"
            assert approve_item["context"]["head_sha"] == SHA
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_approve_actor_resolves_by_name_answers_mystery2():
    """미스터리② 양성대조 — approved 이벤트의 actor가 실명으로 조회되는가."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.pm import Story
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s, email_prefix="teacher")
            story = Story(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                title="#2975 AC4 미스터리② 재현",
            )
            s.add(story)
            await s.commit()
            gate = Gate(
                id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id, work_item_type="story",
                gate_type=MERGE_GATE_TYPE, status="pending",
                approved_head_sha=None, github_check_run_id=1, github_check_run_sha="sha-a4ee601e6",
            )
            s.add(gate)
            await s.commit()
            gate_id = gate.id

        await _setup_app(app, Session, seeded["org_id"], seeded["user_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{gate_id}/transition",
                json={"status": "approved", "note": "실 승인", "evidence_viewed": True,
                      "reviewed_head_sha": "sha-a4ee601e6"},
            )
            assert resp.status_code == 200, resp.text

            resp = await client.get(f"/api/v2/gates/{gate_id}/activity")
            assert resp.status_code == 200, resp.text
            items = resp.json()
            assert len(items) == 1
            assert items[0]["action"] == "gate_approved"
            assert items[0]["actor_id"] == str(seeded["member_id"])
            # User엔 name 필드가 없어(member_resolver.py 실측) actor_name은 email로 해석된다.
            assert items[0]["actor_name"] == seeded["email"], items[0]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_void_gate_now_recorded_in_activity_log():
    """void_gate — 이전엔 logger.info뿐이라 이 엔드포인트에 하나도 안 떴다(진짜 갭). 이제는 뜬다."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            # void 엔드포인트=org owner/admin 전용(is_org_owner_or_admin) — org_role 필요.
            seeded = await _seed_common(s, email_prefix="admin", org_role="owner")
            story = Story(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                title="#2975 AC4 void 회귀",
            )
            s.add(story)
            await s.commit()
            gate = Gate(
                id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id, work_item_type="story",
                gate_type="doc_approval", status="pending",
            )
            s.add(gate)
            await s.commit()
            gate_id = gate.id

        await _setup_app(app, Session, seeded["org_id"], seeded["user_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{gate_id}/void", json={"reason": "잘못 생성됨"},
            )
            assert resp.status_code == 200, resp.text

            resp = await client.get(f"/api/v2/gates/{gate_id}/activity")
            assert resp.status_code == 200, resp.text
            items = resp.json()
            assert len(items) == 1, "void_gate가 ActivityLog에 안 남으면 여기 0건(회귀)"
            assert items[0]["action"] == "gate_voided"
            assert items[0]["context"]["reason"] == "잘못 생성됨"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
