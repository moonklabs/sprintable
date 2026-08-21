"""story #2857(loop-closure P2-B) — 측정 판정 초안=에이전트·확定=휴먼 실PG 검증.

AC 확定(페드루 PO, 2026-08-20):
  ①Gate.neutral_facts 재사용 + 새 gate_type hypothesis_outcome_confirm(_ALWAYS_MANUAL)
  ②scorer 경계=source 축(2845-B는 ga4/internal_ops «아닌» 축만)
  ③기존 게이트 판 재사용 — transition_gate_endpoint가 이미 human-only.
  ⚠️부수 발견 처방(같은 PR 원자 전환): verified/falsified 직통로 human-only화 +
    「차단 회귀: 에이전트 키로 verified 직접 호출=403+게이트 경유는 성립」 짝.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_agent_member,
    _make_human_member,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_agent,
    _setup_app_human,
)
from tests.test_2301_story_body_mentions_realdb import _REAL_DB_URL
from tests.test_2829_loop_measure_due_realdb import _make_hypothesis

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@pytest.mark.anyio
async def test_agent_direct_verified_call_now_403():
    """차단 회귀 — 에이전트 키로 verified 직접 호출은 403(부수 발견 처방)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_id, _ = await _make_human_member(s, org.id, project.id)
            agent_id = await _make_agent_member(s, org.id, project.id)
            hyp = await _make_hypothesis(s, org.id, project.id, owner_id, status="measuring")

        await _setup_app_agent(app, Session, agent_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/hypotheses/{hyp.id}/transition",
                json={"status": "verified", "outcome_result": {"actual": 100, "reason": "달성"}},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_human_owner_direct_verified_call_still_works():
    """무회귀 — owner 휴먼의 직접 verified 호출은 그대로 성립(사람의 길 유지)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_id, owner_user_id = await _make_human_member(s, org.id, project.id)
            hyp = await _make_hypothesis(s, org.id, project.id, owner_id, status="measuring")

        await _setup_app_human(app, Session, owner_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/hypotheses/{hyp.id}/transition",
                json={"status": "verified", "outcome_result": {"actual": 100, "reason": "달성"}},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["status"] == "verified"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_outcome_draft_creates_always_pending_gate():
    """①③ — 에이전트 초안 제출은 항상 pending gate(org posture 무관, _ALWAYS_MANUAL)."""
    from app.main import app
    from app.models.gate import Gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_id, _ = await _make_human_member(s, org.id, project.id)
            agent_id = await _make_agent_member(s, org.id, project.id)
            hyp = await _make_hypothesis(s, org.id, project.id, owner_id, status="measuring")

        await _setup_app_agent(app, Session, agent_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/hypotheses/{hyp.id}/outcome-draft",
                json={"draft_target": "verified", "draft_actual": 42, "draft_reason": "지표 달성 관측"},
            )
            assert resp.status_code == 200, resp.text
            gate_id = uuid.UUID(resp.json()["gate_id"])
            assert resp.json()["gate_status"] == "pending"
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert gate.gate_type == "hypothesis_outcome_confirm"
            assert gate.work_item_type == "hypothesis"
            assert gate.work_item_id == hyp.id
            assert gate.status == "pending"
            assert gate.requires_human is True
            assert gate.neutral_facts == {
                "draft_target": "verified", "draft_actual": 42, "draft_reason": "지표 달성 관측",
            }
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_gate_approval_transitions_hypothesis_and_records_human_closer():
    """②의 반대편 실증 — 초안 gate 승인(휴먼)이 실제로 hypothesis를 verified로 옮기고,
    closed_by=human(승인자)로 서버가 채운다(클라이언트 위조 불가 계약 그대로 유지)."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.hypothesis import Hypothesis
    from app.services.gate_service import transition_gate
    from app.services.hypothesis_outcome_confirm import draft_hypothesis_outcome

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_id, _ = await _make_human_member(s, org.id, project.id)
            approver_id, _ = await _make_human_member(s, org.id, project.id)
            agent_id = await _make_agent_member(s, org.id, project.id)
            hyp = await _make_hypothesis(s, org.id, project.id, owner_id, status="measuring")

            gate = await draft_hypothesis_outcome(
                s, org.id, agent_id, hyp.id,
                draft_target="falsified", draft_actual=3, draft_reason="목표 미달 관측",
            )
            await s.commit()
            assert gate.status == "pending"

            approved = await transition_gate(s, org.id, gate.id, "approved", approver_id, None)
            await s.commit()
            assert approved.status == "approved"

            refreshed = (await s.execute(
                select(Hypothesis).where(Hypothesis.id == hyp.id)
            )).scalar_one()
            assert refreshed.status == "falsified"
            assert refreshed.outcome_result == {
                "actual": 3, "reason": "목표 미달 관측",
                "closed_by": "human", "closed_by_member_id": str(approver_id),
            }
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_gate_rejection_leaves_hypothesis_measuring():
    """②거절 경로 no-op — hypothesis는 measuring 그대로(재초안 가능)."""
    from app.models.hypothesis import Hypothesis
    from app.services.gate_service import transition_gate
    from app.services.hypothesis_outcome_confirm import draft_hypothesis_outcome

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_id, _ = await _make_human_member(s, org.id, project.id)
            approver_id, _ = await _make_human_member(s, org.id, project.id)
            agent_id = await _make_agent_member(s, org.id, project.id)
            hyp = await _make_hypothesis(s, org.id, project.id, owner_id, status="measuring")

            gate = await draft_hypothesis_outcome(
                s, org.id, agent_id, hyp.id,
                draft_target="verified", draft_actual=1, draft_reason="근거 약함",
            )
            await s.commit()

            await transition_gate(s, org.id, gate.id, "rejected", approver_id, "근거 부족")
            await s.commit()

            refreshed = (await s.execute(
                select(Hypothesis).where(Hypothesis.id == hyp.id)
            )).scalar_one()
            assert refreshed.status == "measuring"
            assert refreshed.outcome_result is None
    finally:
        await engine.dispose()
