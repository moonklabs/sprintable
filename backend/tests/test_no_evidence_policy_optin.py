"""SPR-36: 무증거 작업 auto-done의 org 정책 opt-in.

도그푸드 1차 실측(2026-07-19): CI/PR 증거가 없는 report_done은 게이트 미실체화 + auto done —
문서·설정 작업이 사람 싸인을 영영 거치지 않는다. "수용의 기록" 포지셔닝과 충돌하고, 에이전트가
증거를 빼면 게이트를 우회할 수 있는 구멍.

결정(2026-07-20, 옵션 1): **org 단위 opt-in** — `OrgGatePolicy.require_human_without_evidence`
가 true인 org만 무증거 작업도 게이트를 실체화해 사람에게 보낸다(ask_human). 기본값 false =
현행 no-substance no-gate 유지(빈 shell 게이트 양산 방지 설계 존중, 롤아웃 안전).
"""
from __future__ import annotations

import contextlib
import os
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.services import merge_verdict_gate as mod
from app.services.merge_verdict_gate import ASK_HUMAN, AUTO_MERGE, evaluate_merge_gate

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _run_no_substance(*, require_human: bool):
    """무증거 경로(ci None·pr 0) — opt-in 헬퍼를 주입해 분기만 검증."""
    part = SimpleNamespace(member_id=uuid.uuid4(), role_id=uuid.uuid4())
    gate = SimpleNamespace(id=uuid.uuid4(), status="pending")
    with contextlib.ExitStack() as stack:
        stack.enter_context(patch.object(mod, "resolve_implementation_participation",
                                         AsyncMock(return_value=part)))
        stack.enter_context(patch.object(mod, "_role_key", AsyncMock(return_value="implementation")))
        stack.enter_context(patch.object(mod, "resolve_disposition", AsyncMock(return_value="ask")))
        stack.enter_context(patch.object(mod, "_no_evidence_requires_human",
                                         AsyncMock(return_value=require_human)))
        stack.enter_context(patch.object(mod, "capture_pr_ci_verdict",
                                         AsyncMock(return_value={"recorded": [], "skipped_reason": "no_sid_tag"})))
        stack.enter_context(patch.object(mod, "compute_member_trust_scores",
                                         AsyncMock(return_value={"scores": []})))
        stack.enter_context(patch.object(mod, "resolve_work_item_project_id",
                                         AsyncMock(return_value=uuid.uuid4())))
        create_spy = stack.enter_context(patch.object(mod, "create_gate", AsyncMock(return_value=gate)))
        res = await evaluate_merge_gate(
            AsyncMock(), uuid.uuid4(), uuid.uuid4(),
            pr_number=0, repo="", ci_result=None, pr_result=None,
        )
    return res, create_spy


@pytest.mark.anyio
async def test_optin_true_materializes_gate_and_asks_human():
    """opt-in org: 무증거여도 게이트 실체화 + ask_human(자동 통과 금지)."""
    res, create_spy = await _run_no_substance(require_human=True)
    assert res.decision == ASK_HUMAN, "무증거 + opt-in → 사람 싸인"
    assert res.gate_id is not None
    create_spy.assert_awaited_once()


@pytest.mark.anyio
async def test_optin_false_keeps_no_gate_auto_done():
    """기본(off): 현행 no-substance no-gate 유지 — 완전 무변경."""
    res, create_spy = await _run_no_substance(require_human=False)
    assert res.decision == AUTO_MERGE and res.gate_id is None
    assert "no-substance" in res.reason
    create_spy.assert_not_awaited()


@pytest.mark.anyio
async def test_real_db_policy_flag_drives_no_evidence_gating():
    """실 DB: OrgGatePolicy.require_human_without_evidence가 무증거 게이팅을 실제로 구동한다."""
    from sqlalchemy import text as _text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    from app.models.hitl_config import OrgGatePolicy
    from app.models.participation import Participation, ParticipationRole
    from app.models.pm import Story

    if not _REAL_DB_URL:
        pytest.skip("PARITY_TEST_DATABASE_URL/ALEMBIC_DATABASE_URL 미설정")
    url = _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        for flag, want_gate in ((True, True), (False, False)):
            org, project, story_id, member, role_id = (uuid.uuid4() for _ in range(5))
            async with Session() as s:
                await s.execute(_text("SET session_replication_role = replica"))
                s.add_all([
                    ParticipationRole(id=role_id, org_id=org, key="implementation",
                                      label="구현", is_default=True),
                    Story(id=story_id, org_id=org, project_id=project,
                          title="무증거 정책", status="in-progress"),
                    Participation(id=uuid.uuid4(), org_id=org, story_id=story_id,
                                  member_id=member, role_id=role_id),
                    OrgGatePolicy(org_id=org, posture="balanced",
                                  require_human_without_evidence=flag),
                ])
                await s.commit()
            with patch("app.services.verdict_capture.fetch_pr_review_rounds",
                       AsyncMock(return_value=0)):
                async with Session() as s:
                    await s.execute(_text("SET session_replication_role = replica"))
                    res = await evaluate_merge_gate(
                        s, org, story_id, pr_number=0, repo="", ci_result=None, pr_result=None,
                    )
                    await s.commit()
            if want_gate:
                assert res.decision == ASK_HUMAN and res.gate_id is not None, res
            else:
                assert res.decision == AUTO_MERGE and res.gate_id is None, res
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


def test_policy_schema_accepts_and_returns_flag():
    """API 스키마: Create가 플래그를 받고(기본 false) Response가 노출한다."""
    from app.schemas.hitl_config import OrgGatePolicyCreate

    assert OrgGatePolicyCreate(posture="balanced").require_human_without_evidence is False
    body = OrgGatePolicyCreate(posture="balanced", require_human_without_evidence=True)
    assert body.require_human_without_evidence is True
