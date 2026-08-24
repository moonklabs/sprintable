"""story #2975(HIGH, 게이트 신선도 구멍) — 근본원인 확定+GREEN 전환.

원래 RED 재현(2026-08-24 초판): 승인 트랜잭션이 «PO가 화면에서 review한 SHA»가 아니라
«지금 이 순간 gate.github_check_run_sha가 가리키는 SHA»를 anchor로 찍었다(gates.py
transition_gate_endpoint, story #2832가 도입한 1순위 로직). 승인 요청 body가 review 시점
SHA를 전혀 실어 보내지 않아, 승인 클릭과 서버 커밋 사이에 웹훅 구동 publish_gate_check가
github_check_run_sha를 새 SHA로 먼저 갱신해 두면 서버는 그 차이를 구별할 수단이 없었다 —
승인이 «리뷰한 적 없는 새 커밋»에 그대로 anchor됐다(실사고: 2026-08-23 18:57~58, PR#3402,
gate #f07fae4e/story 2969 — PO가 head 2eadc1f44 기준으로 서명했는데 새 SHA a4f57604f
check-run이 즉시 "게이트 상태: approved"로 뜸). reopen_gate_if_new_sha 미발화가 아니라
(#2961 패턴이 다루는 문제가 아님) 애초에 anchor가 새 SHA로 찍혀 «불일치» 자체가 안 생긴
것이었다.

처방(페드루 PO 설계 확定 2026-08-24, gates.py transition_gate_endpoint): body에
`reviewed_head_sha` 신설 — merge 게이트 승인 시 known SHA(gate.github_check_run_sha, not
None)와 불일치하면(필드 누락=None 포함, fail-closed) 409로 거부하고 승인을 진행하지 않는다.
대조는 FOR UPDATE로 이 gate 행을 잠근 뒤 수행(같은 트랜잭션/락 스코프 — 대조~anchor 쓰기
사이에 레이스 윈도가 남지 않는다).

이 파일은 이제 GREEN: 레이스가 나면(사례1 그대로) 승인이 조용히 성공하는 게 아니라 명시
거부돼야 한다. 필드 자체를 안 보내는 옛 클라이언트도 fail-closed로 막힌다. 매칭되는
정상 경로(레이스 없음)는 여전히 200으로 통과한다(양성대조 — 회귀가드가 과잉차단하지 않음
확인)."""
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
    import app.models.activity_log  # noqa: F401 — transition_gate()가 ActivityLog를 씀.

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


async def _seed_common(session):
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

    caller = User(id=uuid.uuid4(), email=f"caller-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller.id, role="member")
    session.add(caller_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=caller_om.id,
        permission="granted", role="owner",
    ))
    await session.commit()

    return {"org_id": org.id, "project_id": project.id, "caller_id": caller.id}


async def _seed_race_gate(session, *, github_check_run_sha):
    from app.models.gate import Gate
    from app.models.pm import Story
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    seeded = await _seed_common(session)
    story = Story(
        id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
        title="#2975 사례1 — 승인 anchor SHA 레이스",
    )
    session.add(story)
    await session.commit()

    gate = Gate(
        id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id, work_item_type="story",
        gate_type=MERGE_GATE_TYPE, status="pending",
        approved_head_sha=None, github_check_run_id=90199, github_check_run_sha=github_check_run_sha,
    )
    session.add(gate)
    await session.commit()
    return seeded, gate.id


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_race_landed_sha_rejected_not_silently_anchored():
    """GREEN(사례1 그대로): PO가 SHA_REVIEWED를 보고 승인 클릭(body에 reviewed_head_sha=
    SHA_REVIEWED로 실어 보냄) 직전, 웹훅 구동 publish_gate_check가 github_check_run_sha를
    SHA_RACE_PUSH로 먼저 갱신(동시성 시뮬레이션 — DB 직접 갱신). 처방 前엔 이게 200+조용한
    오-anchor였다 — 처방 後엔 409로 명시 거부되고 gate는 pending에 그대로 머물러야 한다."""
    from app.models.gate import Gate
    from app.main import app

    SHA_REVIEWED = "sha-2eadc1f44-po-reviewed-this"
    SHA_RACE_PUSH = "sha-a4f57604f-comment-only-push-landed-during-approve"

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded, gate_id = await _seed_race_gate(s, github_check_run_sha=SHA_REVIEWED)

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            # 레이스 시뮬레이션: PO가 승인 버튼을 누르기 직전, Mirko의 comment-only push에 대한
            # synchronize 웹훅이 이미 처리돼(gate_github_check.py::publish_gate_check 백그라운드
            # 태스크) gate.github_check_run_sha가 새 SHA로 먼저 갱신됐다 — PO의 화면은 아직 옛
            # SHA를 보여주고 있지만(리로드 안 함) DB는 이미 새 SHA를 가리킨다.
            async with Session() as race_session:
                race_gate = (await race_session.execute(
                    __import__("sqlalchemy").select(Gate).where(Gate.id == gate_id)
                )).scalar_one()
                race_gate.github_check_run_sha = SHA_RACE_PUSH
                await race_session.commit()

            # PO의 승인 클릭 — body는 review-time SHA(SHA_REVIEWED)를 실어 보낸다(신규 계약).
            resp = await client.post(
                f"/api/v2/gates/{gate_id}/transition",
                json={
                    "status": "approved", "note": "SHA_REVIEWED 기준 서명", "evidence_viewed": True,
                    "reviewed_head_sha": SHA_REVIEWED,
                },
            )
            assert resp.status_code == 409, resp.text
            error = resp.json()["error"]
            assert error["code"] == "gate_head_changed", error
            assert error["current_head_sha"] == SHA_RACE_PUSH, error

            # 승인이 진행되지 않았어야 한다 — status=pending 유지, anchor 미기록.
            async with Session() as verify_session:
                gate_after = (await verify_session.execute(
                    __import__("sqlalchemy").select(Gate).where(Gate.id == gate_id)
                )).scalar_one()
                assert gate_after.status == "pending", "409 거부에도 승인이 진행됐다 — fail-closed 위반"
                assert gate_after.approved_head_sha is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_missing_reviewed_head_sha_rejected_fail_closed():
    """옛 클라이언트(reviewed_head_sha 필드 자체를 모르는 호출자) 시뮬레이션 — 필드를 아예 안
    보내면 Optional 필드 기본값(None)이 known SHA와 자동 불일치해 fail-closed로 막혀야 한다
    (PO 요구 ① — "안 보내는 호출자에게 구멍이 그대로 남으면 안 된다")."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded, gate_id = await _seed_race_gate(s, github_check_run_sha="sha-known-head")

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{gate_id}/transition",
                json={"status": "approved", "note": "필드 누락", "evidence_viewed": True},
            )
            assert resp.status_code == 409, resp.text
            assert resp.json()["error"]["code"] == "gate_head_changed", resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_matching_reviewed_head_sha_approves_normally():
    """양성대조 — 레이스가 전혀 없는 정상 경로(reviewed_head_sha가 현재 known SHA와 정확히
    일치)는 이 회귀가드가 과잉차단하지 않고 그대로 200+정확한 anchor로 통과해야 한다."""
    from app.main import app

    SHA_CURRENT = "sha-no-race-here"

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded, gate_id = await _seed_race_gate(s, github_check_run_sha=SHA_CURRENT)

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{gate_id}/transition",
                json={
                    "status": "approved", "note": "정상 승인", "evidence_viewed": True,
                    "reviewed_head_sha": SHA_CURRENT,
                },
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["status"] == "approved", body
            assert body["approved_head_sha"] == SHA_CURRENT, body
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
