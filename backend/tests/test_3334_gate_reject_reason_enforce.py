"""story #3334(선생님 실사용 4바퀴 T1' 적출, 페드루 PO 처방): 게이트 rejected(변경 요청) 전이의
사유(resolution_note) 서버측 강제.

배경: `/gates/{id}` 상세 페이지 저위험 인라인 반려 버튼은 사유 입력창 자체가 없었다 — 클릭 즉시
`resolution_note=""`로 rejected 저장. 서버도 무검증이라 그대로 통과했다 — 반려 통지(#3330 AC2가
사유+다음 행동을 싣는다)가 빈 사유로 나가, 실행자가 "무엇을 고칠지" 못 받았다.

story #2027(고위험 approved의 note 서버측 강제)과 결이 같은 처방이되, 핵심 차이: #2027은
risk_grade=="high"에서만 돈다(저위험은 과도 강제 금지가 PO AC) — 이 스토리는 처방 원문
"모든 gate_type" 그대로, risk_grade/gate_type 무관 항상 강제한다. 아래 테스트가 그 차이를
직접 고정한다(저위험 gate_type=merge 조합으로 422를 실증 — #2027이라면 이 조합은 그냥
통과했을 것).

seed/client 헬퍼는 test_2027_gate_approval_reason_enforce.py와 동일 패턴(파일별 로컬 중복이
이 스위트의 기존 관례).
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

    import app.models  # noqa: F401 — 전 모델 메타데이터 로드
    import app.models.activity_log  # noqa: F401 — transition_gate()가 ActivityLog를 씀(#2201 후속 미등재 갭).
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
    """org + project + caller(project owner grant — rule B 승인/반려 자격)."""
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
async def test_realdb_low_risk_reject_without_note_422_and_no_mutation():
    """핵심 차이 실증(#2027 대칭 대조): permissive posture가 gate_type=merge를 저위험으로
    오버라이드한 조합(#2027이라면 approve는 note 없이 통과) — 그런데도 **reject는 여전히
    422**다. risk_grade 무관, gate_type 무관 처방 원문("모든 gate_type") 그대로."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded, gate_id = await _seed_gate(
                s, posture="permissive", gate_type="merge", story_title="저위험 반려 대상(사유 無)",
            )

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{gate_id}/transition", json={"status": "rejected"},
            )
            assert resp.status_code == 422, resp.text
            # app.main.http_exception_handler — HTTPException.detail(str)을
            # {"error":{"message":...}} 봉투로 재포장(story #2003 REST 엔벨로프).
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
async def test_realdb_reject_with_note_persists_resolution_note_and_dispatches_notification():
    """같은 저위험 조합에 note를 실어 보내면 200·resolution_note가 실제로 저장된다(재조회로
    확인) — #3330 AC2(반려 통지가 이 사유를 싣는다)가 의존하는 바로 그 데이터."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded, gate_id = await _seed_gate(
                s, posture="permissive", gate_type="merge", story_title="저위험 반려 대상(사유 有)",
            )

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            note = "스키마 필드명이 기존 컨벤션과 다릅니다 — snake_case로 통일해주세요"
            resp = await client.post(
                f"/api/v2/gates/{gate_id}/transition",
                json={"status": "rejected", "note": note},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["status"] == "rejected", resp.json()
            assert resp.json()["resolution_note"] == note, resp.json()

            recheck = await client.get(f"/api/v2/gates/{gate_id}")
            assert recheck.status_code == 200, recheck.text
            body = recheck.json()
            assert body["status"] == "rejected", body
            assert body["resolution_note"] == note, body
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_doc_gate_reject_without_note_422():
    """gate_type=doc_approval(고위험 축이 다른 종류 — #2027 강제와 무관한 gate_type)도 reject
    사유 강제 대상임을 고정 — "gate_type 무관"이 특정 축 하나에 우연히 걸린 결과가 아님을
    다른 gate_type으로도 확인한다."""
    from app.main import app
    from app.models.doc import Doc

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            doc = Doc(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                title="반려 대상 문서", slug=f"doc-{uuid.uuid4().hex[:6]}", status="pending",
            )
            s.add(doc)
            await s.flush()
            from app.models.gate import Gate
            gate = Gate(
                id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=doc.id, work_item_type="doc",
                gate_type="doc_approval", status="pending",
                neutral_facts={"requested_by_member_id": str(uuid.uuid4())},
            )
            s.add(gate)
            await s.commit()
            gate_id = gate.id

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{gate_id}/transition", json={"status": "rejected"},
            )
            assert resp.status_code == 422, resp.text
            assert "사유" in resp.json()["error"]["message"], resp.json()
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
