"""H1-S2: Merge verdict gate service 테스트.

decision 매트릭스(AC①~⑦) + Cage 합성(capture/trust/create_gate 재사용·AC⑥ 매 평가 gate row).
"""
from __future__ import annotations

import os
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import merge_verdict_gate as mod
from app.services.merge_verdict_gate import (
    ASK_HUMAN,
    AUTO_MERGE,
    BLOCK,
    MergeGateDecision,
    _decide,
    _impl_trust,
    _normalize_result,
    evaluate_merge_gate,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── _decide 매트릭스 (AC①~⑦) ──────────────────────────────────────────────────

def _d(**over):
    base = dict(ci="pass", pr="pass", gate_status="auto_passed", trust=0.9, threshold=0.8, self_report_only=False)
    base.update(over)
    return _decide(**base)


def test_decide_ci_fail_blocks():
    assert _d(ci="fail")[0] == BLOCK  # AC①


def test_decide_ci_unknown_asks():
    assert _d(ci=None)[0] == ASK_HUMAN  # AC②
    # AC⑦: self-report만 → 사유에 명시.
    dec, reason = _d(ci=None, self_report_only=True)
    assert dec == ASK_HUMAN and "self-report" in reason


def test_decide_deny_blocks():
    assert _d(gate_status="rejected")[0] == BLOCK


def test_decide_trust_none_asks():
    assert _d(trust=None)[0] == ASK_HUMAN  # AC③


def test_decide_all_conditions_auto_merge():
    assert _d(gate_status="auto_passed", ci="pass", pr="pass", trust=0.85)[0] == AUTO_MERGE  # AC④


def test_decide_ask_posture_asks():
    assert _d(gate_status="pending")[0] == ASK_HUMAN  # AC⑤


def test_decide_trust_below_threshold_asks():
    assert _d(trust=0.5)[0] == ASK_HUMAN  # 전조건 미충족 → safe


def test_decide_pr_fail_not_auto():
    assert _d(pr="fail")[0] == ASK_HUMAN


# ── helper ─────────────────────────────────────────────────────────────────────

def test_normalize_result():
    assert _normalize_result("pass") == "pass" and _normalize_result("success") == "pass"
    assert _normalize_result("failure") == "fail" and _normalize_result(None) is None


def test_impl_trust_extracts_role_rate():
    res = {"scores": [{"role_key": "implementation", "clean_pass_rate": 0.92},
                      {"role_key": "qa", "clean_pass_rate": 0.5}]}
    assert _impl_trust(res, "implementation") == 0.92
    assert _impl_trust({"scores": []}, "implementation") is None  # verdict 없음 → None.


# ── evaluate_merge_gate 오케스트레이션 (Cage 합성·AC⑥) ──────────────────────────

def _patch_cage(*, gate_status="auto_passed", trust_scores=None, capture=None, participation=True):
    part = SimpleNamespace(member_id=uuid.uuid4(), role_id=uuid.uuid4()) if participation else None
    gate = SimpleNamespace(id=uuid.uuid4(), status=gate_status)
    ctx = [
        patch.object(mod, "resolve_implementation_participation", AsyncMock(return_value=part)),
        patch.object(mod, "_role_key", AsyncMock(return_value="implementation")),
        patch.object(mod, "capture_pr_ci_verdict",
                     AsyncMock(return_value=capture or {"recorded": ["pr"], "skipped_reason": None})),
        patch.object(mod, "compute_member_trust_scores",
                     AsyncMock(return_value=trust_scores or {"scores": [{"role_key": "implementation", "clean_pass_rate": 0.9}]})),
        patch.object(mod, "create_gate", AsyncMock(return_value=gate)),
    ]
    return ctx, gate


async def _run(**cage):
    import contextlib

    ctx, gate = _patch_cage(**cage)
    with contextlib.ExitStack() as stack:
        for p in ctx:
            stack.enter_context(p)
        create_spy = stack.enter_context(
            patch.object(mod, "create_gate", AsyncMock(return_value=gate))
        )
        res = await evaluate_merge_gate(
            AsyncMock(), uuid.uuid4(), uuid.uuid4(),
            pr_number=12, repo="o/r", ci_result="pass", pr_result="pass",
        )
    return res, create_spy


@pytest.mark.anyio
async def test_evaluate_auto_merge_path():
    res, create_spy = await _run(gate_status="auto_passed")
    assert res.decision == AUTO_MERGE and res.disposition == "allow_auto"
    assert res.trust == 0.9 and res.gate_id is not None
    create_spy.assert_awaited_once()  # AC⑥: gate row.


@pytest.mark.anyio
async def test_evaluate_trust_none_asks_and_still_creates_gate():
    # R5 초기 안전성: trust 전원 null → ask_human(auto_merge 0).
    res, create_spy = await _run(gate_status="auto_passed", trust_scores={"scores": []})
    assert res.decision == ASK_HUMAN and res.trust is None
    create_spy.assert_awaited_once()  # AC⑥: 사람 보류여도 gate row 남는다.


@pytest.mark.anyio
async def test_evaluate_ask_posture_path():
    res, _ = await _run(gate_status="pending")
    assert res.decision == ASK_HUMAN and res.disposition == "ask"


@pytest.mark.anyio
async def test_evaluate_no_participation_asks_no_gate():
    import contextlib

    ctx, gate = _patch_cage(participation=False)
    with contextlib.ExitStack() as stack:
        for p in ctx:
            stack.enter_context(p)
        create_spy = stack.enter_context(patch.object(mod, "create_gate", AsyncMock(return_value=gate)))
        res = await evaluate_merge_gate(
            AsyncMock(), uuid.uuid4(), uuid.uuid4(),
            pr_number=1, repo="o/r", ci_result="pass",
        )
    assert res.decision == ASK_HUMAN and res.gate_id is None
    create_spy.assert_not_awaited()  # participation 없으면 gate도 안 만든다.


@pytest.mark.anyio
async def test_evaluate_ci_fail_blocks():
    import contextlib

    ctx, gate = _patch_cage(gate_status="auto_passed")
    with contextlib.ExitStack() as stack:
        for p in ctx:
            stack.enter_context(p)
        stack.enter_context(patch.object(mod, "create_gate", AsyncMock(return_value=gate)))
        res = await evaluate_merge_gate(
            AsyncMock(), uuid.uuid4(), uuid.uuid4(),
            pr_number=1, repo="o/r", ci_result="failure",
        )
    assert res.decision == BLOCK and res.ci_result == "fail"


# ── CP⑦ 회귀: capture→trust 순서 + autoflush 자기-부트스트랩 방지 ─────────────────

@pytest.mark.anyio
async def test_trust_computed_before_capture_records():
    """순서 보장: compute_member_trust_scores가 capture_pr_ci_verdict보다 먼저 호출돼야 한다.

    capture가 현재 verdict를 session.add → autoflush가 그 뒤 trust 쿼리에 딸려보내면 신규
    contributor가 현재 PR로 trust=1.0 자기-부트스트랩(→evidence-less auto_merge). 순서로 차단.
    """
    order: list[str] = []
    part = SimpleNamespace(member_id=uuid.uuid4(), role_id=uuid.uuid4())

    async def _trust(*a, **k):
        order.append("trust")
        return {"scores": []}

    async def _capture(*a, **k):
        order.append("capture")
        return {"recorded": ["pr"], "skipped_reason": None}

    with patch.object(mod, "resolve_implementation_participation", AsyncMock(return_value=part)), \
         patch.object(mod, "_role_key", AsyncMock(return_value="implementation")), \
         patch.object(mod, "compute_member_trust_scores", side_effect=_trust), \
         patch.object(mod, "capture_pr_ci_verdict", side_effect=_capture), \
         patch.object(mod, "create_gate", AsyncMock(return_value=SimpleNamespace(id=uuid.uuid4(), status="auto_passed"))):
        await evaluate_merge_gate(AsyncMock(), uuid.uuid4(), uuid.uuid4(), pr_number=1, repo="o/r", ci_result="pass")

    assert order == ["trust", "capture"], f"trust must precede capture, got {order}"


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_new_contributor_no_self_bootstrap_real_db():
    """실 compute(mock 아님)·실 autoflush: 신규 contributor가 현재 PR 하나로 trust를 자기-부트스트랩
    하지 않아 allow_auto org서도 첫 평가가 auto_merge가 아니라 ask_human(trust None)임을 입증."""
    from sqlalchemy import text as _text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401 — 전 모델 메타데이터 로드
    from app.models.gate import Gate
    from app.models.hitl_config import OrgGatePolicy
    from app.models.participation import Participation, ParticipationRole
    from app.models.pm import Story
    from app.models.verdict import Verdict

    url = _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )
    engine = create_async_engine(url)
    org = uuid.uuid4()
    project = uuid.uuid4()
    story_id = uuid.uuid4()
    member = uuid.uuid4()
    role_id = uuid.uuid4()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))  # 시드 FK 우회.
            s.add_all([
                ParticipationRole(id=role_id, org_id=org, key="implementation", label="구현", is_default=True),
                Story(id=story_id, org_id=org, project_id=project, title="신규 contributor 스토리", story_points=5),
                Participation(id=uuid.uuid4(), org_id=org, story_id=story_id, member_id=member, role_id=role_id),
                OrgGatePolicy(org_id=org, posture="permissive"),  # → allow_auto disposition.
            ])
            await s.commit()

        with patch("app.services.verdict_capture.fetch_pr_review_rounds", AsyncMock(return_value=0)):
            async with Session() as s:
                await s.execute(_text("SET session_replication_role = replica"))
                res = await evaluate_merge_gate(
                    s, org, story_id, pr_number=7, repo="o/r", ci_result="pass", pr_result="pass"
                )
                await s.commit()

        # 핵심: disposition=allow_auto + CI pass + PR pass인데도 trust None → ask_human(auto_merge 아님).
        assert res.trust is None, f"신규 contributor trust는 None이어야(자기-부트스트랩 금지), got {res.trust}"
        assert res.decision == ASK_HUMAN, f"trust None이면 ask_human이어야, got {res.decision}"
        assert res.disposition == "allow_auto"  # 정책은 allow_auto였음을 확인(증거 부족으로 보류).

        # capture는 현재 verdict를 *기록*했다(이후 평가용) — autoflush로 trust에 샌 게 아님.
        async with Session() as s:
            cnt = (await s.execute(
                _text("SELECT count(*) FROM verdict v JOIN participation p ON p.id=v.participation_id "
                      "WHERE p.member_id=:m"), {"m": member}
            )).scalar()
            assert cnt >= 1, "현재 verdict는 capture가 기록했어야(이후 평가 history)"
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
