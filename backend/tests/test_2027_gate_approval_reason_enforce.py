"""story #2027: 고위험(risk_grade=high) 게이트 approved 전이의 사유(note) 서버측 강제.

배경(까심 QA 실 PG+실 HTTP 재현): 고위험 게이트의 "근거 열람 + 사유 입력" 요건이 FE 버튼
disable(evidenceViewed && reason.trim())로만 있었고 서버는 무검증이었다 — `POST /gates/{id}
/transition`을 직접 호출하면 사유 없이 200으로 통과하고 `resolution_note`가 null로 남았다.

핵심 판단(오르테가 PO): 같은 라우터의 void_gate/override_gate는 이미 reason 을 서버에서 강제하는데
(reason 없으면 ValueError→422) approved 전이만 그 관례에서 이탈해 있었다 — 새 규칙이 아니라 기존
관례에 맞추는 정합 작업.

이 파일 구성:
- risk_grade=high + note 없음 → 422·전이 미적용(뮤테이션 0, GET 재조회로 확인).
- risk_grade=high + note 있음 → 200·resolution_note 실제 저장(재조회로 확인 — story #2027 이전엔
  approved 에 resolution_note 가 전혀 저장되지 않았다).
- risk_grade=low(posture=permissive 가 gate_type=merge 를 오버라이드) → note 없이도 기존대로 200
  (과도 강제 금지 — 저위험 회귀 없음).

seed/client 헬퍼는 test_1972_gate_risk_grade.py 의 realdb 섹션과 동일 패턴(파일별 로컬 중복이
이 테스트 스위트의 기존 관례).
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# realdb 섹션이 Base.metadata.create_all을 호출한다 — conftest.py AST 가드(story 8236bbc3) 대응.
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

    from app.core.database import Base
    import app.models  # noqa: F401 — 전 모델 메타데이터 로드

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


async def _seed_common(session):
    """org + project + caller(project grant, has_project_access True 경로)."""
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
        permission="granted", role="member",
    ))
    await session.commit()

    return {"org_id": org.id, "project_id": project.id, "caller_id": caller.id}


async def _seed_gate(session, *, posture: str, gate_type: str, story_title: str):
    from app.models.gate import Gate
    from app.models.hitl_config import OrgGatePolicy
    from app.models.pm import Story

    seeded = await _seed_common(session)
    session.add(OrgGatePolicy(org_id=seeded["org_id"], posture=posture))
    await session.commit()
    story = Story(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                  title=story_title)
    session.add(story)
    await session.commit()
    gate = Gate(id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id,
                work_item_type="story", gate_type=gate_type, status="pending")
    session.add(gate)
    await session.commit()
    return seeded, gate.id


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_high_risk_approve_without_note_422_and_no_mutation():
    """conservative posture → pr_review 도 high(1차 축이 이김, test_1972 동일 조합). note 없이
    approve 시도 → 422·gate 는 pending 그대로(전이 미적용)를 재조회로 확인 — 강제 이전엔 이 조합이
    200으로 통과하고 resolution_note 가 null 로 남았었다(까심 QA 재현)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded, gate_id = await _seed_gate(
                s, posture="conservative", gate_type="pr_review", story_title="고위험 승인 대상",
            )

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{gate_id}/transition", json={"status": "approved"},
            )
            assert resp.status_code == 422, resp.text
            # app.main.http_exception_handler 가 HTTPException.detail(str)을 {"error":{"message":...}}
            # 봉투로 재포장(story #2003 REST 엔벨로프) — {"detail":...} 아님(raw FastAPI 기본과 다름).
            assert "사유" in resp.json()["error"]["message"], resp.json()

            # 뮤테이션 0 확인 — 재조회(feedback_verify_commit_race: 직후 상태를 API 재조회로 입증).
            recheck = await client.get(f"/api/v2/gates/{gate_id}")
            assert recheck.status_code == 200, recheck.text
            body = recheck.json()
            assert body["status"] == "pending", body
            assert body["resolution_note"] is None, body
            assert body["resolved_at"] is None, body
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_high_risk_approve_with_note_persists_resolution_note():
    """같은 고위험 조합에 note 를 실어 보내면 200·resolution_note 가 실제로 저장된다(재조회로 확인
    — story #2027 이전엔 approved 전이가 resolution_note 를 rejected 전용 분기라 저장하지 않았다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded, gate_id = await _seed_gate(
                s, posture="conservative", gate_type="pr_review", story_title="고위험 승인(사유 有)",
            )

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            note = "PR diff 전체 + CI green 확인, 마이그레이션 없음 확인 후 승인"
            resp = await client.post(
                f"/api/v2/gates/{gate_id}/transition",
                json={"status": "approved", "note": note},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["resolution_note"] == note, resp.json()
            assert resp.json()["status"] == "approved", resp.json()

            recheck = await client.get(f"/api/v2/gates/{gate_id}")
            assert recheck.status_code == 200, recheck.text
            body = recheck.json()
            assert body["status"] == "approved", body
            assert body["resolution_note"] == note, body
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_low_risk_approve_without_note_still_succeeds():
    """permissive posture 가 gate_type=merge(2차 축이면 high)를 오버라이드해 low(test_1972 동일
    조합). note 없이 approve 해도 기존대로 200 — 과도 강제 금지(PO AC 명시)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded, gate_id = await _seed_gate(
                s, posture="permissive", gate_type="merge", story_title="저위험 승인 대상",
            )

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{gate_id}/transition", json={"status": "approved"},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["status"] == "approved", resp.json()
            assert resp.json()["resolution_note"] is None, resp.json()
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
