"""story #2038: 가설 verified/falsified 전이의 outcome_result(수치+근거) 서버측 강제.

배경(까심 QA — PR #2303/#2036 검수 중 적출, #2027과 동일 구조): `HypothesisResolveDialog`
(FE, story #2036)는 "실제 수치(actual)+한 줄 근거(reason) 둘 다 없으면 제출 불가"를 강제하지만
서버(`POST /api/v2/hypotheses/{id}/transition`)는 이 요건을 몰랐다 — `outcome_result`를 완전히
생략하고 endpoint를 직접 호출하면 근거 없이 200으로 가설이 닫혔다.

이 파일 구성:
- verified/falsified + outcome_result 없음(또는 actual/reason 결여) → 422·전이 미적용(뮤테이션 0).
- verified/falsified + 유효 outcome_result(actual 수치 + reason 비어있지 않음) → 200·저장됨.
- active/killed 등 다른 전이는 outcome_result 없이도 기존대로 통과(과도 강제 금지).
- 자동채점 cron(hypothesis_scorer.score_hypotheses)은 이 가드와 무관한 별개 경로(직접 ORM
  write·transition_hypothesis 미경유)임을 실제로 호출해 실증 — Ortega가 "가장 위험한 자리"로
  지목한 지점.

seed/client 헬퍼는 test_e_cage_referee_p3_gate_object.py류 realdb 섹션(#2027에서 쓴 gates 패턴)과
동형 — 파일별 로컬 중복이 이 테스트 스위트의 기존 관례.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

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
    """org + project + caller(human org member)."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
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

    return {"org_id": org.id, "project_id": project.id, "caller_id": caller_om.id, "caller_user_id": caller.id}


async def _seed_measuring_hypothesis(session, org_id, project_id, owner_member_id):
    from app.models.hypothesis import Hypothesis

    hyp = Hypothesis(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, owner_member_id=owner_member_id,
        statement="측정 중 가설", metric_definition={
            "metric": "signups", "source": "manual", "target": 100, "direction": "up",
        },
        measure_after=datetime.now(timezone.utc) - timedelta(days=1), status="measuring",
    )
    session.add(hyp)
    await session.commit()
    return hyp.id


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_verified_without_outcome_result_422_and_no_mutation():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            hyp_id = await _seed_measuring_hypothesis(
                s, seeded["org_id"], seeded["project_id"], seeded["caller_id"],
            )

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_user_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/hypotheses/{hyp_id}/transition", json={"status": "verified"},
            )
            assert resp.status_code == 422, resp.text
            assert resp.json()["error"]["code"] == "OUTCOME_RESULT_REQUIRED", resp.json()

            recheck = await client.get(f"/api/v2/hypotheses/{hyp_id}")
            assert recheck.status_code == 200, recheck.text
            body = recheck.json()
            assert body["status"] == "measuring", body
            assert body["outcome_result"] is None, body
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_falsified_with_actual_but_no_reason_422_and_no_mutation():
    """actual만 있고 reason이 빈 문자열이면 여전히 거부(FE canSubmit의 reason.trim().length>0 미러)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            hyp_id = await _seed_measuring_hypothesis(
                s, seeded["org_id"], seeded["project_id"], seeded["caller_id"],
            )

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_user_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/hypotheses/{hyp_id}/transition",
                json={"status": "falsified", "outcome_result": {"actual": 42, "reason": "   "}},
            )
            assert resp.status_code == 422, resp.text
            assert resp.json()["error"]["code"] == "OUTCOME_RESULT_REQUIRED", resp.json()

            recheck = await client.get(f"/api/v2/hypotheses/{hyp_id}")
            assert recheck.json()["status"] == "measuring"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_verified_with_valid_outcome_result_persists():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            hyp_id = await _seed_measuring_hypothesis(
                s, seeded["org_id"], seeded["project_id"], seeded["caller_id"],
            )

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_user_id"])
        client = _client_for(app)
        try:
            outcome = {"actual": 137, "reason": "가입 137건으로 목표 100건 초과 달성"}
            resp = await client.post(
                f"/api/v2/hypotheses/{hyp_id}/transition",
                json={"status": "verified", "outcome_result": outcome},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["status"] == "verified", resp.json()
            assert resp.json()["outcome_result"] == outcome, resp.json()

            recheck = await client.get(f"/api/v2/hypotheses/{hyp_id}")
            body = recheck.json()
            assert body["status"] == "verified", body
            assert body["outcome_result"] == outcome, body
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_killed_transition_unaffected_no_outcome_result_required():
    """verified/falsified 외 전이(killed)는 outcome_result 없이도 기존대로 통과 — 과도 강제 금지."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            hyp_id = await _seed_measuring_hypothesis(
                s, seeded["org_id"], seeded["project_id"], seeded["caller_id"],
            )

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_user_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/hypotheses/{hyp_id}/transition", json={"status": "killed"},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["status"] == "killed", resp.json()
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_auto_scorer_bypasses_guard_entirely():
    """Ortega가 "가장 위험한 자리"로 지목한 지점: hypothesis_scorer.score_hypotheses(cron)는
    transition_hypothesis()를 거치지 않고 hyp.status/outcome_result를 직접 ORM으로 쓴다
    (app/services/hypothesis_scorer.py:123 부근) — 이 가드가 자동채점을 막지 않음을 실측한다.
    manual source는 자동채점 대상이 아니므로(§10.4) internal_ops로 시딩해 실제 hit 경로를 태운다:
    링크된 스토리 100%가 done이면 completion_pct=100 >= target=100(direction=up) → hit → verified.
    outcome_result 없이(요청 자체가 없음) verified로 닫히는 것이 바로 "가드 미적용" 증거다."""
    from app.services.hypothesis_scorer import score_hypotheses

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            from app.models.hypothesis import Hypothesis, HypothesisStoryLink
            from app.models.pm import Story

            seeded = await _seed_common(s)
            hyp = Hypothesis(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                owner_member_id=seeded["caller_id"], statement="internal_ops 자동채점 대상",
                metric_definition={
                    "metric": "completion_pct", "source": "internal_ops", "target": 100, "direction": "up",
                },
                measure_after=datetime.now(timezone.utc) - timedelta(days=1), status="active",
            )
            s.add(hyp)
            await s.commit()
            story = Story(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                title="완료 스토리", status="done",
            )
            s.add(story)
            await s.commit()
            s.add(HypothesisStoryLink(id=uuid.uuid4(), hypothesis_id=hyp.id, story_id=story.id))
            await s.commit()

            result = await score_hypotheses(s)
            await s.commit()

            assert str(hyp.id) in result["verified"], result
            await s.refresh(hyp)
            assert hyp.status == "verified"
            assert hyp.outcome_result is not None  # 가드를 거치지 않고도 스코어러가 채워 넣음
    finally:
        await engine.dispose()
