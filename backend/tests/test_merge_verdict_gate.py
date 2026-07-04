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
    MIN_OUTCOME_SAMPLE,
    TRUST_BASIS,
    MergeGateDecision,
    _decide,
    _normalize_result,
    _outcome_stats,
    _wilson_lower_bound,
    evaluate_merge_gate,
)
from app.services import merge_verdict_gate as _mvg

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all/drop_all로 자체 스키마 직접 관리 — 공유 alembic-migrated DB
# 오염 방지 위해 격리 DB 전용(conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── _decide 매트릭스 (HO-S6: outcome trust 기반·AC①~⑦) ──────────────────────────

def _oc(hit, resolved, pending=0):
    """outcome 신뢰 근거 stub(실 Wilson 하한으로 구성)."""
    hr = round(hit / resolved, 4) if resolved else None
    regret = round((resolved - hit) / resolved, 4) if resolved else None
    return _mvg._OutcomeStats(
        hit=hit, resolved=resolved, pending=pending, hit_rate=hr,
        lower_bound=_wilson_lower_bound(hit, resolved), regret=regret,
    )


# 기본: 90/100 적중 → Wilson 하한 ≈0.83 ≥0.8(충분 표본·높은 하한) → auto 후보.
_OC_STRONG = _oc(90, 100)


def _d(**over):
    base = dict(ci="pass", pr="pass", gate_status="auto_passed", outcome=_OC_STRONG,
                threshold=0.8, min_sample=MIN_OUTCOME_SAMPLE, self_report_only=False)
    base.update(over)
    return _decide(**base)


def test_decide_ci_fail_blocks():
    assert _d(ci="fail")[0] == BLOCK  # AC②: CI fail은 trust 무관 차단.


def test_decide_ci_unknown_asks():
    assert _d(ci=None)[0] == ASK_HUMAN  # AC③
    dec, reason = _d(ci=None, self_report_only=True)
    assert dec == ASK_HUMAN and "self-report" in reason


def test_decide_deny_blocks():
    assert _d(gate_status="rejected")[0] == BLOCK


def test_decide_outcome_sample_insufficient_asks():
    # AC④: outcome 표본 부족(resolved<min) → 사람. 적중률 100%여도 표본 적으면 보류.
    dec, reason = _d(outcome=_oc(2, 2))
    assert dec == ASK_HUMAN and "sample insufficient" in reason and TRUST_BASIS in reason


def test_decide_strong_outcome_auto_merge():
    # AC⑤⑦: 충분 표본 + 높은 Wilson 하한 → auto. 사유에 trust_basis 명시.
    dec, reason = _d(outcome=_OC_STRONG)
    assert dec == AUTO_MERGE and TRUST_BASIS in reason and "lower_bound" in reason


def test_decide_ask_posture_asks():
    assert _d(gate_status="pending")[0] == ASK_HUMAN


def test_decide_lower_bound_below_threshold_asks():
    # 표본 충분(10)이나 하한<임계(8/10→LB≈0.49) → 자동 불가, 사람.
    dec, reason = _d(outcome=_oc(8, 10))
    assert dec == ASK_HUMAN and TRUST_BASIS in reason


def test_decide_ci_pass_alone_not_auto():
    # AC⑦: CI pass만(outcome 표본 0) → 절대 auto 아님.
    assert _d(outcome=_oc(0, 0))[0] == ASK_HUMAN


def test_decide_pr_fail_not_auto():
    assert _d(pr="fail")[0] == ASK_HUMAN


# ── helper ─────────────────────────────────────────────────────────────────────

def test_normalize_result():
    assert _normalize_result("pass") == "pass" and _normalize_result("success") == "pass"
    assert _normalize_result("failure") == "fail" and _normalize_result(None) is None


def test_outcome_stats_extracts_role_outcome():
    # HO-S6: trust 결과(HO-S5)에서 지정 역할의 outcome 근거 추출.
    res = {"scores": [
        {"role_key": "implementation", "hit": 7, "resolved": 10, "pending": 2, "hit_rate": 0.7},
        {"role_key": "qa", "hit": 1, "resolved": 2, "pending": 0, "hit_rate": 0.5},
    ]}
    oc = _outcome_stats(res, "implementation")
    assert oc.hit == 7 and oc.resolved == 10 and oc.pending == 2 and oc.hit_rate == 0.7
    assert 0 < oc.lower_bound < 0.7 and oc.regret == 0.3  # 하한<점추정·regret=miss rate.
    empty = _outcome_stats({"scores": []}, "implementation")
    assert empty.resolved == 0 and empty.hit_rate is None and empty.lower_bound == 0.0


def test_wilson_lower_bound_sample_aware():
    # 표본 작으면 하한이 점추정보다 크게 낮아진다(보수적). n=0→0.
    assert _wilson_lower_bound(0, 0) == 0.0
    assert _wilson_lower_bound(1, 1) < 0.5          # 1/1=100%지만 하한은 낮음.
    assert _wilson_lower_bound(90, 100) > _wilson_lower_bound(9, 10)  # 표본 클수록 하한↑.


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
                     AsyncMock(return_value=trust_scores or {"scores": [{
                         "role_key": "implementation", "clean_pass_rate": 0.9,
                         "hit": 90, "resolved": 100, "pending": 0, "hit_rate": 0.9}]})),
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
    # HO-S6: trust=outcome hit_rate(점추정)·근거 명시·하한 노출.
    assert res.trust == 0.9 and res.gate_id is not None
    assert res.trust_basis == TRUST_BASIS and res.outcome_resolved == 100
    assert res.outcome_lower_bound >= 0.8 and res.outcome_regret == 0.1
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


# ── H1-FIX-1: evaluate가 decision 메타를 gate row에 영속화 ────────────────────────

@pytest.mark.anyio
async def test_evaluate_persists_decision_metadata_on_gate():
    """dogfood 버그 회귀: ask_human 게이트의 S3 evidence 메타가 gate row에 write-back돼야
    (이전엔 리턴엔 있으나 영속화 0 → FE가 null 읽어 GateInbox 액션 미노출)."""
    gate = SimpleNamespace(
        id=uuid.uuid4(), status="pending",
        requires_human=False, evidence_status=None, decision_basis=None, auto_decision_reason=None,
    )
    part = SimpleNamespace(member_id=uuid.uuid4(), role_id=uuid.uuid4())
    with patch("app.services.merge_verdict_gate.resolve_implementation_participation",
               AsyncMock(return_value=part)), \
         patch("app.services.merge_verdict_gate._role_key", AsyncMock(return_value="implementation")), \
         patch("app.services.merge_verdict_gate.capture_pr_ci_verdict",
               AsyncMock(return_value={"recorded": [], "skipped_reason": "x"})), \
         patch("app.services.merge_verdict_gate.compute_member_trust_scores",
               AsyncMock(return_value={"scores": []})), \
         patch("app.services.merge_verdict_gate.create_gate", AsyncMock(return_value=gate)):
        res = await evaluate_merge_gate(
            AsyncMock(), uuid.uuid4(), uuid.uuid4(),
            pr_number=1, repo="o/r", ci_result="pass", pr_result="pass",
        )
    assert res.decision == ASK_HUMAN  # trust None(pending) → ask_human.
    # 메타가 decision과 일치하게 gate row에 영속화(write-back).
    assert gate.requires_human is True
    assert gate.evidence_status == "insufficient"
    assert gate.decision_basis == res.reason
    assert gate.auto_decision_reason == ASK_HUMAN


@pytest.mark.anyio
async def test_evaluate_auto_merge_metadata_sufficient():
    gate = SimpleNamespace(id=uuid.uuid4(), status="auto_passed",
                           requires_human=True, evidence_status=None, decision_basis=None, auto_decision_reason=None)
    part = SimpleNamespace(member_id=uuid.uuid4(), role_id=uuid.uuid4())
    with patch("app.services.merge_verdict_gate.resolve_implementation_participation", AsyncMock(return_value=part)), \
         patch("app.services.merge_verdict_gate._role_key", AsyncMock(return_value="implementation")), \
         patch("app.services.merge_verdict_gate.capture_pr_ci_verdict", AsyncMock(return_value={"recorded": ["pr"], "skipped_reason": None})), \
         patch("app.services.merge_verdict_gate.compute_member_trust_scores",
               AsyncMock(return_value={"scores": [{"role_key": "implementation", "clean_pass_rate": 0.95,
                   "hit": 95, "resolved": 100, "pending": 0, "hit_rate": 0.95}]})), \
         patch("app.services.merge_verdict_gate.create_gate", AsyncMock(return_value=gate)):
        res = await evaluate_merge_gate(AsyncMock(), uuid.uuid4(), uuid.uuid4(),
                                        pr_number=1, repo="o/r", ci_result="pass", pr_result="pass")
    assert res.decision == AUTO_MERGE
    assert gate.requires_human is False and gate.evidence_status == "sufficient"
    assert gate.auto_decision_reason == AUTO_MERGE


# ── HO-S6 키스톤 실DB: 가설 적중 이력만으로 auto_merge ──────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_strong_outcome_track_record_auto_merges_real_db():
    """실 compute(mock 아님): implementation 멤버가 과거 hypothesis_outcome_execution verdict를
    충분히(25건 pass) 쌓으면 Wilson 하한≥0.8 → allow_auto org서 auto_merge. 신뢰 근거가 CI가 아닌
    가설 적중 이력(trust_basis=hypothesis_outcome)임을 실DB로 입증(AC①⑤⑥)."""
    from datetime import datetime, timezone

    from sqlalchemy import text as _text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    from app.models.hitl_config import OrgGatePolicy
    from app.models.participation import Participation, ParticipationRole
    from app.models.pm import Story
    from app.models.verdict import Verdict
    from app.services.hypothesis_outcome_verdict import EXECUTION_SOURCE

    url = _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )
    engine = create_async_engine(url)
    org, project, role_id, member = (uuid.uuid4() for _ in range(4))
    cur_story = uuid.uuid4()
    now = datetime.now(timezone.utc)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add_all([
                ParticipationRole(id=role_id, org_id=org, key="implementation", label="구현", is_default=True),
                OrgGatePolicy(org_id=org, posture="permissive"),  # → allow_auto.
                Story(id=cur_story, org_id=org, project_id=project, title="현재 PR", story_points=5),
                Participation(id=uuid.uuid4(), org_id=org, story_id=cur_story, member_id=member, role_id=role_id),
            ])
            # 과거 25건: 각 스토리에 implementation participation + execution verdict(result=pass).
            for _ in range(25):
                sid = uuid.uuid4()
                pid = uuid.uuid4()
                s.add_all([
                    Story(id=sid, org_id=org, project_id=project, title="과거", status="done", story_points=3),
                    Participation(id=pid, org_id=org, story_id=sid, member_id=member, role_id=role_id),
                    Verdict(id=uuid.uuid4(), org_id=org, participation_id=pid,
                            source=EXECUTION_SOURCE, result="pass", rounds=0, recorded_at=now),
                ])
            await s.commit()

        with patch("app.services.verdict_capture.fetch_pr_review_rounds", AsyncMock(return_value=0)):
            async with Session() as s:
                await s.execute(_text("SET session_replication_role = replica"))
                res = await evaluate_merge_gate(
                    s, org, cur_story, pr_number=9, repo="o/r", ci_result="pass", pr_result="pass"
                )
                await s.commit()

        # 가설 적중 이력(25/25)만으로 Wilson 하한≥0.8 → auto_merge. 근거=hypothesis_outcome.
        assert res.decision == AUTO_MERGE, res.reason
        assert res.trust_basis == TRUST_BASIS
        assert res.outcome_resolved == 25 and res.outcome_hit_rate == 1.0
        assert res.outcome_lower_bound >= 0.8 and res.outcome_regret == 0.0
        assert TRUST_BASIS in res.reason
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


# ── P0 (E-DG-REAL 1ff89d23): evidence-driven materialization (빈 shell 박멸) ──────
import contextlib  # noqa: E402


async def _run_substance(*, ci_result, pr_number, disposition):
    """substance 가드 경로 — participation 있음, disposition 주입, create_gate spy 반환."""
    part = SimpleNamespace(member_id=uuid.uuid4(), role_id=uuid.uuid4())
    gate = SimpleNamespace(id=uuid.uuid4(), status="pending")
    with contextlib.ExitStack() as stack:
        stack.enter_context(patch.object(mod, "resolve_implementation_participation",
                                         AsyncMock(return_value=part)))
        stack.enter_context(patch.object(mod, "_role_key", AsyncMock(return_value="implementation")))
        stack.enter_context(patch.object(mod, "resolve_disposition",
                                         AsyncMock(return_value=disposition)))
        stack.enter_context(patch.object(mod, "capture_pr_ci_verdict",
                                         AsyncMock(return_value={"recorded": [], "skipped_reason": "no_sid_tag"})))
        stack.enter_context(patch.object(mod, "compute_member_trust_scores",
                                         AsyncMock(return_value={"scores": []})))
        create_spy = stack.enter_context(patch.object(mod, "create_gate", AsyncMock(return_value=gate)))
        res = await evaluate_merge_gate(
            AsyncMock(), uuid.uuid4(), uuid.uuid4(),
            pr_number=pr_number, repo=("o/r" if pr_number else ""),
            ci_result=ci_result, pr_result=None,
        )
    return res, create_spy


@pytest.mark.anyio
async def test_no_substance_no_gate_materialized():
    """무증거(ci None·pr 0·정책 ask) → 게이트 미생성·no-gate(AUTO_MERGE)·row 0."""
    res, create_spy = await _run_substance(ci_result=None, pr_number=0, disposition="ask")
    assert res.decision == AUTO_MERGE
    assert res.gate_id is None
    assert "no-substance" in res.reason
    create_spy.assert_not_awaited()  # 빈 shell 안 만든다.


@pytest.mark.anyio
async def test_no_substance_allow_auto_also_no_gate():
    """무증거 + 정책 allow_auto → 동일하게 no-gate(done 통과·row 0)."""
    res, create_spy = await _run_substance(ci_result=None, pr_number=0, disposition="allow_auto")
    assert res.decision == AUTO_MERGE and res.gate_id is None
    create_spy.assert_not_awaited()


@pytest.mark.anyio
async def test_ci_result_present_materializes_gate():
    """CI 결과 있음(green/red) → substance → 게이트 생성(기존 동작 보존)."""
    res, create_spy = await _run_substance(ci_result="fail", pr_number=0, disposition="ask")
    assert res.gate_id is not None
    assert res.decision == BLOCK  # red CI 하드블록(무회귀).
    create_spy.assert_awaited_once()


@pytest.mark.anyio
async def test_connected_pr_materializes_gate():
    """연결 PR(pr_number>0) → substance → 게이트 생성(증거 평가 대상)."""
    res, create_spy = await _run_substance(ci_result=None, pr_number=7, disposition="ask")
    assert res.gate_id is not None
    create_spy.assert_awaited_once()


@pytest.mark.anyio
async def test_deny_policy_materializes_even_without_evidence():
    """명시 deny 정책 → 증거 없어도 게이트 생성(하드블록 honor)."""
    res, create_spy = await _run_substance(ci_result=None, pr_number=0, disposition="deny")
    assert res.gate_id is not None
    create_spy.assert_awaited_once()
