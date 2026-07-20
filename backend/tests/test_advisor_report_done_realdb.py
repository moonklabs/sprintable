"""Real PostgreSQL report-done rails for Harness-local Advisor P0."""
from __future__ import annotations

import os
import uuid
import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
pytestmark = [pytest.mark.skipif(not _REAL_DB_URL, reason="requires isolated migrated PostgreSQL")]


@pytest.fixture
def anyio_backend(): return "asyncio"


def _async_url():
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if _REAL_DB_URL.startswith(prefix):
            return "postgresql+asyncpg://" + _REAL_DB_URL[len(prefix):]
    return _REAL_DB_URL


async def _factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed(session):
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import Project
    from app.models.project_access import ProjectAccess
    org = Organization(id=uuid.uuid4(), name="Advisor report", slug=f"advisor-report-{uuid.uuid4().hex[:12]}")
    session.add(org); await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project); await session.commit()
    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="A")
    other = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="B")
    session.add_all([agent, other]); await session.commit()
    session.add_all([
        ProjectAccess(id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted", role="member"),
        ProjectAccess(id=uuid.uuid4(), project_id=project.id, member_id=other.id, permission="granted", role="member"),
    ]); await session.commit()
    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="S", status="in-progress")
    session.add(story); await session.commit()
    return org.id, project.id, story.id, agent.id, other.id


async def _setup(app, Session, org_id, agent_id):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.dependencies.database import get_db
    async def db():
        async with Session() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise
    async def auth():
        return AuthContext(user_id=str(agent_id), email=None,
                           claims={"app_metadata": {"org_id": str(org_id), "api_key_id": "advisor-test"}},
                           org_id=str(org_id))
    async def org(): return org_id
    app.dependency_overrides[get_db] = db
    app.dependency_overrides[get_current_user] = auth
    app.dependency_overrides[get_verified_org_id] = org


def _extension(story_id, agent_id, stage="dev"):
    return {"story_id": str(story_id), "stage": stage, "agent_id": str(agent_id), "summary": "done",
            "head_sha": "abcdef1", "intent_hash": "a" * 64,
            "self_review": {"schema_version": 1, "mode": "local", "verdict": "likely_pass",
                            "findings": [], "keep": []}}


@pytest.mark.anyio
async def test_feature_off_preserves_legacy_request_and_writes_no_advisor_evidence(monkeypatch):
    from app.core.config import settings
    from app.main import app
    from app.models.evidence import Evidence
    engine, Session = await _factory()
    try:
        async with Session() as s: org, _project, story, agent, _other = await _seed(s)
        monkeypatch.setattr(settings, "advisor_p0_enabled", False)
        await _setup(app, Session, org, agent)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/api/v2/workflow/report-done", json={
                "story_id": str(story), "stage": "dev", "agent_id": str(agent)})
        assert response.status_code == 200, response.text
        async with Session() as s:
            assert (await s.execute(select(func.count()).select_from(Evidence).where(Evidence.org_id == org))).scalar_one() == 0
    finally:
        app.dependency_overrides.clear(); await engine.dispose()


@pytest.mark.anyio
async def test_extension_spoof_is_rejected_before_any_db_mutation(monkeypatch):
    from app.core.config import settings
    from app.main import app
    from app.models.evidence import Evidence
    from app.models.gate import Gate
    from app.models.pm import Story
    engine, Session = await _factory()
    try:
        async with Session() as s:
            org, _project, story, agent, other = await _seed(s)
            before_status = (await s.get(Story, story)).status
        monkeypatch.setattr(settings, "advisor_p0_enabled", True)
        monkeypatch.setattr(settings, "advisor_p0_org_allowlist", str(org))
        monkeypatch.setattr(settings, "advisor_p0_provenance_approved_orgs", str(org))
        await _setup(app, Session, org, agent)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/api/v2/workflow/report-done", json=_extension(story, other))
        assert response.status_code == 403, response.text
        async with Session() as s:
            assert (await s.get(Story, story)).status == before_status
            assert (await s.execute(select(func.count()).select_from(Evidence).where(Evidence.org_id == org))).scalar_one() == 0
            assert (await s.execute(select(func.count()).select_from(Gate).where(Gate.org_id == org))).scalar_one() == 0
    finally:
        app.dependency_overrides.clear(); await engine.dispose()


@pytest.mark.anyio
async def test_successful_extension_persists_canonical_bounded_claim(monkeypatch):
    from app.core.config import settings
    from app.main import app
    from app.models.evidence import Evidence
    from app.services.advisor_context import RESERVED_EVIDENCE_SOURCE
    engine, Session = await _factory()
    try:
        async with Session() as s: org, _project, story, agent, _other = await _seed(s)
        monkeypatch.setattr(settings, "advisor_p0_enabled", True)
        monkeypatch.setattr(settings, "advisor_p0_org_allowlist", str(org))
        monkeypatch.setattr(settings, "advisor_p0_provenance_approved_orgs", str(org))
        await _setup(app, Session, org, agent)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/api/v2/workflow/report-done", json=_extension(story, agent))
        assert response.status_code == 200, response.text
        async with Session() as s:
            evidence = (await s.execute(select(Evidence).where(Evidence.org_id == org,
                Evidence.source == RESERVED_EVIDENCE_SOURCE))).scalar_one()
            assert evidence.created_by == agent
            assert evidence.ref.startswith("sha256:")
            assert len(evidence.note.encode("utf-8")) <= 32_768
            assert evidence.note == '{"head_sha":"abcdef1","intent_hash":"' + "a" * 64 + '","self_review":{"advisor_model":null,"findings":[],"keep":[],"mode":"local","schema_version":1,"verdict":"likely_pass"},"summary":"done"}'
    finally:
        app.dependency_overrides.clear(); await engine.dispose()


@pytest.mark.anyio
async def test_pending_human_merge_202_commits_claim_and_origin_pointer(monkeypatch):
    from app.core.config import settings
    from app.main import app
    from app.models.evidence import Evidence
    from app.models.gate import Gate
    from app.services.merge_verdict_gate import ASK_HUMAN, MergeGateDecision
    engine, Session = await _factory()
    try:
        async with Session() as s:
            org, _project, story, agent, _other = await _seed(s)
            gate = Gate(id=uuid.uuid4(), org_id=org, work_item_id=story, work_item_type="story",
                        gate_type="merge", status="pending", requires_human=True, neutral_facts={})
            s.add(gate); await s.commit(); gate_id = gate.id
        for name, value in (("advisor_p0_enabled", True), ("advisor_p0_org_allowlist", str(org)),
                            ("advisor_p0_provenance_approved_orgs", str(org))): monkeypatch.setattr(settings, name, value)
        decision = MergeGateDecision(decision=ASK_HUMAN, reason="human", gate_id=gate_id,
                                     gate_status="pending", disposition="ask", trust=None, ci_result=None)
        await _setup(app, Session, org, agent)
        with patch("app.routers.workflow_report.merge_gate_active", return_value=True), \
             patch("app.routers.workflow_report.evaluate_merge_gate", new=AsyncMock(return_value=decision)):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                response = await client.post("/api/v2/workflow/report-done", json=_extension(story, agent, "merge"))
        assert response.status_code == 202, response.text
        async with Session() as s:
            evidence = (await s.execute(select(Evidence).where(Evidence.org_id == org,
                Evidence.source == "advisor.executor_claim.v1"))).scalar_one()
            gate = await s.get(Gate, gate_id)
            origin = gate.neutral_facts["advisor_origin"]
            assert origin["evidence_id"] == str(evidence.id)
            assert origin["recipient_id"] == str(agent)
            assert evidence.ref == f'sha256:{origin["claim_hash"]}'
    finally:
        app.dependency_overrides.clear(); await engine.dispose()


@pytest.mark.anyio
async def test_config_enforcement_409_preserves_claim_in_audit_commit(monkeypatch):
    from app.core.config import settings
    from app.main import app
    from app.models.evidence import Evidence
    engine, Session = await _factory()
    try:
        async with Session() as s: org, _project, story, agent, _other = await _seed(s)
        for name, value in (("advisor_p0_enabled", True), ("advisor_p0_org_allowlist", str(org)),
                            ("advisor_p0_provenance_approved_orgs", str(org)),
                            ("gate_config_enforce_enabled", True), ("gate_config_enforce_org_allowlist", str(org))):
            monkeypatch.setattr(settings, name, value)
        await _setup(app, Session, org, agent)
        with patch("app.services.gate_enforce._resolve_level_failclosed", new=AsyncMock(return_value="block")):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                response = await client.post("/api/v2/workflow/report-done", json=_extension(story, agent, "merge"))
        assert response.status_code == 409, response.text
        assert "GATE_BLOCKED" in response.text
        async with Session() as s:
            evidence = (await s.execute(select(Evidence).where(Evidence.org_id == org,
                Evidence.source == "advisor.executor_claim.v1"))).scalar_one()
            assert evidence.created_by == agent
            assert evidence.ref.startswith("sha256:")
    finally:
        app.dependency_overrides.clear(); await engine.dispose()


@pytest.mark.anyio
async def test_non_merge_line_409_preserves_claim_without_advisor_origin(monkeypatch):
    from app.core.config import settings
    from app.main import app
    from app.models.evidence import Evidence
    from app.models.gate import Gate
    from app.services.workflow_line_engine import LineDecision
    engine, Session = await _factory()
    try:
        async with Session() as s: org, _project, story, agent, _other = await _seed(s)
        for name, value in (("advisor_p0_enabled", True), ("advisor_p0_org_allowlist", str(org)),
                            ("advisor_p0_provenance_approved_orgs", str(org))): monkeypatch.setattr(settings, name, value)
        blocked = LineDecision(mode="blocked_by_policy", status_to_apply=None,
                               blocking_reason="line policy", http_status=409)
        await _setup(app, Session, org, agent)
        with patch("app.services.workflow_line_engine.evaluate_line_for_transition", new=AsyncMock(return_value=blocked)):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                response = await client.post("/api/v2/workflow/report-done", json=_extension(story, agent, "dev"))
        assert response.status_code == 409, response.text
        assert "LINE_BLOCKED" in response.text
        async with Session() as s:
            assert (await s.execute(select(func.count()).select_from(Evidence).where(
                Evidence.org_id == org, Evidence.source == "advisor.executor_claim.v1"))).scalar_one() == 1
            gates = (await s.execute(select(Gate).where(Gate.org_id == org))).scalars().all()
            assert all("advisor_origin" not in (gate.neutral_facts or {}) for gate in gates)
    finally:
        app.dependency_overrides.clear(); await engine.dispose()


@pytest.mark.anyio
async def test_merge_block_409_preserves_claim_but_never_stamps_terminal_gate(monkeypatch):
    from app.core.config import settings
    from app.main import app
    from app.models.evidence import Evidence
    from app.models.gate import Gate
    from app.services.merge_verdict_gate import BLOCK, MergeGateDecision
    engine, Session = await _factory()
    try:
        async with Session() as s:
            org, _project, story, agent, _other = await _seed(s)
            gate = Gate(id=uuid.uuid4(), org_id=org, work_item_id=story, work_item_type="story",
                        gate_type="merge", status="rejected", requires_human=True, neutral_facts={})
            s.add(gate); await s.commit(); gate_id = gate.id
        for name, value in (("advisor_p0_enabled", True), ("advisor_p0_org_allowlist", str(org)),
                            ("advisor_p0_provenance_approved_orgs", str(org))): monkeypatch.setattr(settings, name, value)
        decision = MergeGateDecision(decision=BLOCK, reason="policy", gate_id=gate_id,
                                     gate_status="rejected", disposition="deny", trust=None, ci_result="fail")
        await _setup(app, Session, org, agent)
        with patch("app.routers.workflow_report.merge_gate_active", return_value=True), \
             patch("app.routers.workflow_report.evaluate_merge_gate", new=AsyncMock(return_value=decision)):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                response = await client.post("/api/v2/workflow/report-done", json=_extension(story, agent, "merge"))
        assert response.status_code == 409, response.text
        async with Session() as s:
            assert (await s.execute(select(func.count()).select_from(Evidence).where(
                Evidence.org_id == org, Evidence.source == "advisor.executor_claim.v1"))).scalar_one() == 1
            gate = await s.get(Gate, gate_id)
            assert "advisor_origin" not in (gate.neutral_facts or {})
    finally:
        app.dependency_overrides.clear(); await engine.dispose()


@pytest.mark.anyio
async def test_two_concurrent_report_done_claims_both_persist_and_one_origin_wins(monkeypatch):
    from fastapi import BackgroundTasks, Response
    from app.core.config import settings
    from app.dependencies.auth import AuthContext
    from app.models.evidence import Evidence
    from app.models.gate import Gate
    from app.routers.workflow_report import ReportDoneRequest, report_done
    from app.services.merge_verdict_gate import ASK_HUMAN, MergeGateDecision
    engine, Session = await _factory()
    try:
        async with Session() as s:
            org, _project, story, agent_a, agent_b = await _seed(s)
            gate = Gate(id=uuid.uuid4(), org_id=org, work_item_id=story, work_item_type="story",
                        gate_type="merge", status="pending", requires_human=True, neutral_facts={})
            s.add(gate); await s.commit(); gate_id = gate.id
        for name, value in (("advisor_p0_enabled", True), ("advisor_p0_org_allowlist", str(org)),
                            ("advisor_p0_provenance_approved_orgs", str(org))): monkeypatch.setattr(settings, name, value)
        decision = MergeGateDecision(decision=ASK_HUMAN, reason="human", gate_id=gate_id,
                                     gate_status="pending", disposition="ask", trust=None, ci_result=None)

        async def submit(agent_id, summary):
            auth = AuthContext(user_id=str(agent_id), email=None,
                claims={"app_metadata": {"org_id": str(org), "api_key_id": f"key-{agent_id}"}}, org_id=str(org))
            body = ReportDoneRequest(**_extension(story, agent_id, "merge") | {"summary": summary})
            async with Session() as session:
                result = await report_done(body, BackgroundTasks(), Response(), session, org, auth)
                await session.commit()
                return result

        with patch("app.routers.workflow_report.merge_gate_active", return_value=True), \
             patch("app.routers.workflow_report.evaluate_merge_gate", new=AsyncMock(return_value=decision)):
            results = await asyncio.gather(submit(agent_a, "claim-a"), submit(agent_b, "claim-b"))
        assert len(results) == 2
        async with Session() as s:
            evidence = (await s.execute(select(Evidence).where(Evidence.org_id == org,
                Evidence.source == "advisor.executor_claim.v1"))).scalars().all()
            assert len(evidence) == 2
            by_id = {str(item.id): item for item in evidence}
            gate = await s.get(Gate, gate_id)
            origin = gate.neutral_facts["advisor_origin"]
            winner = by_id[origin["evidence_id"]]
            assert winner.created_by == uuid.UUID(origin["recipient_id"])
            assert winner.ref == f'sha256:{origin["claim_hash"]}'
            assert {item.created_by for item in evidence} == {agent_a, agent_b}
    finally:
        await engine.dispose()
