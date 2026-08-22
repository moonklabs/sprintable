"""story #2893(설계안 gate-auto-creation-design-2893 §3, PR③/B3) — 명시적 재평가 API.

`POST /api/v2/gates/{id}/reevaluate` — reopen(PR을 실제로 close→reopen)이나 「참여등록 후
빈 커밋 push」(오늘 #3324가 실제로 쓴 수동 경로) 같은 우회를 표준 경로로 승격한다. reopen과
달리 GitHub 쪽 리뷰/체크 상태를 전혀 건드리지 않는다(순수 GET으로 현재 head SHA/merged를
읽어와 우리 쪽 게이트 판정만 reconcile_merge_gate_with_real_evidence로 재실행).

GitHub API 호출(get_installation_token/get_pull_request/fetch_status_check_rollup)만 mock —
DB 왕복·평가 로직(참여/신뢰/disposition)은 실 Postgres+실 함수(test_2156의 reconcile realdb
테스트와 동일 관례).
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.destructive_schema,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
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

    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.activity_log  # noqa: F401 — transition_gate류 경로가 ActivityLog를 씀.

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


async def _seed(session, *, with_project_access=True, with_participation=True, with_installation=True):
    from app.models.github_installation import GithubInstallation
    from app.models.organization import Organization
    from app.models.participation import Participation, ParticipationRole
    from app.models.pm import Story
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="재평가 대상 스토리")
    session.add(story)
    await session.commit()

    caller = User(id=uuid.uuid4(), email=f"caller-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller.id, role="member")
    session.add(caller_om)
    await session.commit()
    if with_project_access:
        session.add(ProjectAccess(
            id=uuid.uuid4(), project_id=project.id, org_member_id=caller_om.id,
            permission="granted", role="member",
        ))
        await session.commit()

    if with_participation:
        role = ParticipationRole(id=uuid.uuid4(), org_id=org.id, key="dev", label="Dev", is_default=True)
        session.add(role)
        await session.commit()
        member_id = uuid.uuid4()
        session.add(Participation(
            id=uuid.uuid4(), org_id=org.id, story_id=story.id, role_id=role.id, member_id=member_id,
        ))
        await session.commit()

    if with_installation:
        session.add(GithubInstallation(
            id=uuid.uuid4(), org_id=org.id, installation_id=770001, account_login="moonklabs",
        ))
        await session.commit()

    return {"org_id": org.id, "project_id": project.id, "story_id": story.id, "caller_id": caller.id}


async def _seed_pending_merge_gate(session, seeded, *, pr_number=55, repo="moonklabs/sprintable"):
    """cold-start(참여는 있으나 신뢰 이력 0)라 evaluate_merge_gate가 pending을 낸다 — 재평가
    전/후 reason 변화로 "실 증거가 실제로 반영됐는지"를 관측한다(test_2156과 동일 관례)."""
    from app.services.merge_verdict_gate import evaluate_merge_gate

    with (
        patch(
            "app.services.merge_verdict_gate.resolve_disposition",
            AsyncMock(return_value=("ask", "org_policy")),
        ),
        patch(
            "app.services.merge_verdict_gate._is_meaningfully_explicit_ask",
            AsyncMock(return_value=True),
        ),
    ):
        await evaluate_merge_gate(
            session, seeded["org_id"], seeded["story_id"],
            pr_number=pr_number, repo=repo, ci_result=None, pr_result=None,
        )
    await session.commit()

    from sqlalchemy import select

    from app.models.gate import Gate
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    gate = (
        await session.execute(
            select(Gate).where(Gate.work_item_id == seeded["story_id"], Gate.gate_type == MERGE_GATE_TYPE)
        )
    ).scalar_one()
    return gate


def _gh_patches(*, head_sha="sha-fresh", merged=False, ci_result="success"):
    return (
        patch("app.routers.gates.get_installation_token", AsyncMock(return_value="inst-tok")),
        patch(
            "app.routers.gates.get_pull_request",
            AsyncMock(return_value={"head": {"sha": head_sha}, "merged": merged}),
        ),
        patch(
            "app.routers.gates.fetch_status_check_rollup",
            AsyncMock(return_value=(ci_result, None)),
        ),
    )


@pytest.mark.anyio
async def test_reevaluate_updates_pending_gate_with_fresh_github_evidence():
    """핵심 — 재평가가 실제로 evaluate_merge_gate를 재실행해 reason이 "CI unknown"에서
    "outcome sample insufficient"로 바뀐다(실 CI 증거가 게이트에 도달했다는 관측 가능한 증거,
    test_2156의 reconcile 실증과 동일 축). reopen과 달리 GitHub 쪽 상태 변경 호출(check-run
    생성/라벨 제거 등)은 이 흐름 자체에서 전혀 일어나지 않는다(순수 GET만 mock됨)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
            gate = await _seed_pending_merge_gate(s, seeded)
            gate_id = gate.id
            assert "CI unknown" in (gate.decision_basis or ""), "cold-start 전제 확인"

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            p1, p2, p3 = _gh_patches(head_sha="sha-fresh", merged=False, ci_result="success")
            with (
                p1, p2, p3,
                patch(
                    "app.services.merge_verdict_gate.resolve_disposition",
                    AsyncMock(return_value=("ask", "org_policy")),
                ),
                patch(
                    "app.services.merge_verdict_gate._is_meaningfully_explicit_ask",
                    AsyncMock(return_value=True),
                ),
            ):
                resp = await client.post(f"/api/v2/gates/{gate_id}/reevaluate")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert "CI unknown" not in (body.get("decision_basis") or ""), body
            assert "outcome sample insufficient" in (body.get("decision_basis") or ""), body
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_reevaluate_rejects_non_merge_gate_type():
    from app.main import app
    from app.models.gate import Gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
            gate = Gate(
                id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=seeded["story_id"],
                work_item_type="story", gate_type="qa", status="pending",
            )
            s.add(gate)
            await s.commit()
            gate_id = gate.id

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/gates/{gate_id}/reevaluate")
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_reevaluate_rejects_approved_gate_status():
    """approved는 landed 작업 — 재평가로 흔들면 안 된다(create_gate 재오픈 규율과 같은 축)."""
    from app.main import app
    from app.models.gate import Gate
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
            gate = Gate(
                id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=seeded["story_id"],
                work_item_type="story", gate_type=MERGE_GATE_TYPE, status="approved",
                pr_number=55, neutral_facts={"repo": "moonklabs/sprintable"},
            )
            s.add(gate)
            await s.commit()
            gate_id = gate.id

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/gates/{gate_id}/reevaluate")
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_reevaluate_rejects_gate_without_pr_context():
    from app.main import app
    from app.models.gate import Gate
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
            gate = Gate(
                id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=seeded["story_id"],
                work_item_type="story", gate_type=MERGE_GATE_TYPE, status="pending",
                pr_number=None, neutral_facts=None,
            )
            s.add(gate)
            await s.commit()
            gate_id = gate.id

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/gates/{gate_id}/reevaluate")
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_reevaluate_422_when_no_github_installation():
    from app.main import app
    from app.models.gate import Gate
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, with_installation=False)
            gate = Gate(
                id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=seeded["story_id"],
                work_item_type="story", gate_type=MERGE_GATE_TYPE, status="pending",
                pr_number=55, neutral_facts={"repo": "moonklabs/sprintable"},
            )
            s.add(gate)
            await s.commit()
            gate_id = gate.id

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/gates/{gate_id}/reevaluate")
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_reevaluate_no_project_access_returns_404():
    """authz — get_gate_endpoint과 동일(존재 비노출): project 접근권 없으면 404(403 아님)."""
    from app.main import app
    from app.models.gate import Gate
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, with_project_access=False)
            gate = Gate(
                id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=seeded["story_id"],
                work_item_type="story", gate_type=MERGE_GATE_TYPE, status="pending",
                pr_number=55, neutral_facts={"repo": "moonklabs/sprintable"},
            )
            s.add(gate)
            await s.commit()
            gate_id = gate.id

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/gates/{gate_id}/reevaluate")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_reevaluate_unknown_gate_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/gates/{uuid.uuid4()}/reevaluate")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
