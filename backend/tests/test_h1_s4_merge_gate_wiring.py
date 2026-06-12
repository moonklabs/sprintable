"""H1-S4: report-done stage=merge 게이트 적용 테스트.

merge 단계에서 evaluate_merge_gate(S2) decision으로 done 전이를 게이트(auto_merge만 done·
ask_human 202·block 409)하고 gate evidence metadata(S3)를 기록하는지 검증.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.services.merge_verdict_gate import ASK_HUMAN, AUTO_MERGE, BLOCK, MergeGateDecision

ORG_ID = uuid.uuid4()
STORY_ID = uuid.uuid4()
AGENT_ID = uuid.UUID("9cac9d96-5474-45f7-941e-787407597b52")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _mock_story(status="in-review"):
    s = MagicMock()
    s.id = STORY_ID
    s.org_id = ORG_ID
    s.project_id = uuid.uuid4()
    s.title = "스토리"
    s.status = status
    return s


async def _client():
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from app.main import app

    ctx = MagicMock()
    ctx.user_id = str(AGENT_ID)
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    session = AsyncMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = _mock_story()
    session.execute = AsyncMock(return_value=result)

    async def override_db():
        yield session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), session, app


def _decision(decision, **over):
    base = dict(
        decision=decision, reason="r", gate_id=uuid.uuid4(), gate_status="auto_passed",
        disposition="allow_auto", trust=0.9, ci_result="pass",
    )
    base.update(over)
    return MergeGateDecision(**base)


def _body(stage="merge", ctx=None):
    b = {"story_id": str(STORY_ID), "stage": stage, "agent_id": str(AGENT_ID)}
    if ctx is not None:
        b["context"] = ctx
    return b


# ── AC②: auto_merge → done(200) ───────────────────────────────────────────────

@pytest.mark.anyio
async def test_auto_merge_sets_done():
    client, _, app = await _client()
    try:
        with patch("app.routers.workflow_report.evaluate_merge_gate",
                   new=AsyncMock(return_value=_decision(AUTO_MERGE))) as gate, \
             patch("app.routers.workflow_report._record_gate_evidence", new=AsyncMock()), \
             patch("app.repositories.story.StoryRepository.update", new_callable=AsyncMock) as upd:
            async with client as c:
                resp = await c.post("/api/v2/workflow/report-done",
                                    json=_body(ctx={"pr_number": 9, "repo": "o/r", "ci_result": "pass", "pr_result": "pass"}))
        assert resp.status_code == 200
        data = resp.json()
        assert data["story_status"] == "done" and data["gate_decision"] == "auto_merge"
        assert data["requires_human"] is False
        upd.assert_called_once()  # done 전이 발생.
        gate.assert_awaited_once()  # AC⑤: 게이트 1회.
    finally:
        app.dependency_overrides.clear()


# ── AC①: ask_human → status 유지(202) ─────────────────────────────────────────

@pytest.mark.anyio
async def test_ask_human_keeps_status_202():
    client, _, app = await _client()
    try:
        with patch("app.routers.workflow_report.evaluate_merge_gate",
                   new=AsyncMock(return_value=_decision(ASK_HUMAN, gate_status="pending", disposition="ask", trust=None))), \
             patch("app.routers.workflow_report._record_gate_evidence", new=AsyncMock()), \
             patch("app.repositories.story.StoryRepository.update", new_callable=AsyncMock) as upd:
            async with client as c:
                resp = await c.post("/api/v2/workflow/report-done", json=_body(ctx={"ci_result": "pass"}))
        assert resp.status_code == 202  # 사람 보류.
        data = resp.json()
        assert data["story_status"] is None  # done 전이 안 함(유지).
        assert data["gate_decision"] == "ask_human" and data["requires_human"] is True
        upd.assert_not_called()  # status update 호출 0.
    finally:
        app.dependency_overrides.clear()


# ── AC③: block → status 유지(409) ─────────────────────────────────────────────

@pytest.mark.anyio
async def test_block_returns_409_keeps_status():
    client, _, app = await _client()
    try:
        with patch("app.routers.workflow_report.evaluate_merge_gate",
                   new=AsyncMock(return_value=_decision(BLOCK, reason="CI fail", ci_result="fail"))), \
             patch("app.routers.workflow_report._record_gate_evidence", new=AsyncMock()), \
             patch("app.repositories.story.StoryRepository.update", new_callable=AsyncMock) as upd:
            async with client as c:
                resp = await c.post("/api/v2/workflow/report-done", json=_body(ctx={"ci_result": "fail"}))
        assert resp.status_code == 409
        # main.py 핸들러가 dict detail을 envelope error로 패스스루(code/message + 추가 키).
        err = resp.json()["error"]
        assert err["code"] == "MERGE_BLOCKED" and err["decision"] == "block"
        assert err["requires_human"] is True
        upd.assert_not_called()  # done 전이 안 함.
    finally:
        app.dependency_overrides.clear()


# ── AC④: 비-merge 단계는 게이트 미호출 ────────────────────────────────────────

@pytest.mark.anyio
async def test_non_merge_stage_does_not_invoke_gate():
    client, _, app = await _client()
    try:
        with patch("app.routers.workflow_report.evaluate_merge_gate", new=AsyncMock()) as gate, \
             patch("app.repositories.story.StoryRepository.update", new_callable=AsyncMock):
            async with client as c:
                resp = await c.post("/api/v2/workflow/report-done", json=_body(stage="review"))
        assert resp.status_code == 200
        gate.assert_not_awaited()  # merge 외 단계는 게이트 0.
    finally:
        app.dependency_overrides.clear()


# ── gate evidence metadata 기록(S3 컬럼) ───────────────────────────────────────

@pytest.mark.anyio
async def test_record_gate_evidence_sets_columns():
    from app.routers.workflow_report import _record_gate_evidence

    gate = SimpleNamespace(requires_human=False, evidence_status=None, decision_basis=None, auto_decision_reason=None)
    session = AsyncMock()
    session.get = AsyncMock(return_value=gate)
    await _record_gate_evidence(session, _decision(ASK_HUMAN, reason="needs review"))
    assert gate.requires_human is True  # auto_merge 아니면 사람 필요.
    assert gate.evidence_status == "insufficient"
    assert gate.decision_basis == "needs review" and gate.auto_decision_reason == "ask_human"

    # auto_merge → requires_human False·evidence sufficient.
    g2 = SimpleNamespace(requires_human=True, evidence_status=None, decision_basis=None, auto_decision_reason=None)
    session.get = AsyncMock(return_value=g2)
    await _record_gate_evidence(session, _decision(AUTO_MERGE, reason="ok"))
    assert g2.requires_human is False and g2.evidence_status == "sufficient"


@pytest.mark.anyio
async def test_record_gate_evidence_noop_when_no_gate():
    from app.routers.workflow_report import _record_gate_evidence

    session = AsyncMock()
    session.get = AsyncMock()
    await _record_gate_evidence(session, _decision(ASK_HUMAN, gate_id=None))
    session.get.assert_not_awaited()  # gate_id None이면 조회 0.
