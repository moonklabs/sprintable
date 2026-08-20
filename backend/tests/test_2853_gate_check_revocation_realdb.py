"""story #2853([결함·Gate], PO 확定 2026-08-20) — 재평가 판정이 AUTO_MERGE에서 이탈해도
이미 선 success check-run이 안 뒤집히던 라이브 구멍(story #2817 그라운딩 중 발견, 순환
재설계와 독립).

AC①: `verdict_capture.py`의 `reconcile_merge_gate_with_real_evidence()` 반환 decision을
버리지 않고 `gate_check_publish`로 배선.
AC②: anchor-clear 분기(merge_verdict_gate.py)에서 `gate.status`를 "pending"으로 재전이
(reopen_gate_if_new_sha의 재-pending과 동일 의미론 — "같은 SHA·증거 회귀").
AC③(계약, PO 확定 — 처음 "self-healing 유지"라 썼다가 실측으로 철회): **자동 복귀는 없다.**
`create_gate()`의 멱등 반환(rejected 외엔 disposition 재확認 0)이 구조적 불변식이라, pending
으로 떨어진 gate는 CI가 나중에 회복돼도 자동으로 auto_passed에 재도달 못 한다 — 재개는
사람이 결재함에서 다시 승인하는 경로뿐.
AC④: pending 재전이·재발행이 반복 방문에도 안정(재평가 루프 없음).
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch

import pytest

from tests.test_2156_merge_gate_evidence_realdb import (
    _gate_row,
    _seed_story_with_participation,
    _session_factory,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.destructive_schema,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed_anchored_auto_passed_gate(session, seeded, *, head_sha="sha-live"):
    """이미 AUTO_MERGE를 통과해(anchor+success check 발행이 전제됐던) 상태를 직접 시드 —
    evaluate_merge_gate로 그 상태에 자연 도달하려면 trust cold-start를 전부 채워야 해(무관한
    복잡도) 회귀가 검증하려는 축(anchor-clear 분기)만 격리해 직접 만든다."""
    from app.models.gate import Gate
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    gate = Gate(
        id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=seeded["story_id"],
        work_item_type="story", gate_type=MERGE_GATE_TYPE, status="auto_passed",
        approved_head_sha=head_sha, github_check_run_id=90001, github_check_run_sha=head_sha,
        requires_human=False,
    )
    session.add(gate)
    await session.commit()
    return gate


@pytest.mark.anyio
async def test_reconcile_flips_auto_passed_to_pending_and_clears_anchor_on_evidence_regression():
    """AC② — 같은 SHA 재평가로 decision이 AUTO_MERGE 이탈(CI 재실패)하면 anchor 소거+
    status="pending" 재전이."""
    from app.services.merge_verdict_gate import AUTO_MERGE, reconcile_merge_gate_with_real_evidence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_story_with_participation(s)
            await _seed_anchored_auto_passed_gate(s, seeded, head_sha="sha-live")

        async with Session() as s:
            decision = await reconcile_merge_gate_with_real_evidence(
                s, seeded["org_id"], seeded["story_id"],
                pr_number=1, repo="moonklabs/sprintable", ci_result="fail", merged=False,
                head_sha="sha-live",
            )
            await s.commit()

        assert decision is not None
        assert decision.decision != AUTO_MERGE

        async with Session() as s:
            gate = await _gate_row(s, seeded["story_id"])
            assert gate.status == "pending"
            assert gate.approved_head_sha is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_pending_after_regression_is_stable_across_repeated_reconcile_visits():
    """AC③④ — 자동 복귀 없음(계약)·재평가 루프 없음. pending으로 떨어진 뒤 CI가 다시
    pass여도(gate_status가 이미 pending이라 _decide의 AUTO_MERGE 조건에 못 닿음) status는
    pending에 안정적으로 머문다 — 매 방문마다 값이 흔들리지 않는다."""
    from app.services.merge_verdict_gate import AUTO_MERGE, reconcile_merge_gate_with_real_evidence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_story_with_participation(s)
            await _seed_anchored_auto_passed_gate(s, seeded, head_sha="sha-live")

        # 1차 방문 — 이탈.
        async with Session() as s:
            await reconcile_merge_gate_with_real_evidence(
                s, seeded["org_id"], seeded["story_id"],
                pr_number=1, repo="moonklabs/sprintable", ci_result="fail", merged=False,
                head_sha="sha-live",
            )
            await s.commit()
        async with Session() as s:
            gate = await _gate_row(s, seeded["story_id"])
            assert gate.status == "pending"

        # 2차 방문 — CI가 회복(pass)했다고 재신고해도 gate_status가 이미 "pending"이라
        # _decide()의 AUTO_MERGE 조건(gate_status=="auto_passed")에 다시 못 닿는다(계약,
        # create_gate 멱등 반환이 구조적으로 강제 — AC③ docstring 참고). auto_passed로
        # 저절로 안 돌아오는지 확認.
        async with Session() as s:
            decision2 = await reconcile_merge_gate_with_real_evidence(
                s, seeded["org_id"], seeded["story_id"],
                pr_number=1, repo="moonklabs/sprintable", ci_result="pass", merged=False,
                head_sha="sha-live",
            )
            await s.commit()
        assert decision2 is not None
        assert decision2.decision != AUTO_MERGE, "계약 위반 — pending은 자동으로 auto_passed에 재도달하면 안 됨"

        async with Session() as s:
            gate = await _gate_row(s, seeded["story_id"])
            assert gate.status == "pending", "재방문마다 값이 흔들리면 안 됨(재평가 루프 없음)"
            assert gate.approved_head_sha is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_process_webhook_event_queues_gate_check_publish_on_reconcile_decision():
    """AC① — 예전엔 이 반환값을 버려 재평가 결과가 GitHub check-run에 전혀 안 닿았다.
    `_process_webhook_event`가 reconcile decision을 gate_check_publish에 실제로 큐잉하는지
    (test_2156의 예외-불삼킴 테스트와 동형 harness — reconcile을 mock해 wiring만 격리 검증)."""
    from app.models.github_installation import GithubInstallation, GithubWebhookDelivery
    from app.routers.verdict_capture import _process_webhook_event
    from app.services.merge_verdict_gate import ASK_HUMAN, MergeGateDecision
    from app.services.pr_story_link import ResolvedLink

    story_id = uuid.uuid4()
    org_id = uuid.uuid4()
    gate_id = uuid.uuid4()
    installation = GithubInstallation(
        id=uuid.uuid4(), installation_id=123, org_id=org_id, account_login="moonklabs",
    )
    delivery = GithubWebhookDelivery(
        id=uuid.uuid4(), source="app", delivery_id="d2853", event="pull_request", status="received",
    )
    payload = {
        "repository": {"full_name": "moonklabs/sprintable"},
        "pull_request": {
            "number": 42, "merged": True, "title": "fix(#1): x",
            "head": {"ref": "fix/1-x", "sha": "sha-live"},
        },
        "action": "closed",
        "installation": {"id": 123},
    }

    session = AsyncMock()
    exec_result = AsyncMock()
    exec_result.scalar_one_or_none = lambda: installation
    session.execute = AsyncMock(return_value=exec_result)

    flipped_decision = MergeGateDecision(
        decision=ASK_HUMAN, reason="evidence regressed", gate_id=gate_id,
        gate_status="pending", disposition="allow_auto", trust=None, ci_result="fail",
    )
    _gate_check_publish: list[dict] = []

    with (
        patch(
            "app.routers.verdict_capture.resolve_story_for_pr",
            AsyncMock(return_value=ResolvedLink(story_id, org_id, "sid", "high", True, "sid_exact")),
        ),
        patch(
            "app.routers.verdict_capture.capture_pr_ci_verdict",
            AsyncMock(return_value={"recorded": ["pr"], "skipped_reason": None}),
        ),
        patch("app.routers.verdict_capture.merge_link_evidence", AsyncMock()),
        patch("app.routers.verdict_capture.get_installation_token", AsyncMock(return_value=None)),
        patch(
            "app.routers.verdict_capture.reconcile_merge_gate_with_real_evidence",
            AsyncMock(return_value=flipped_decision),
        ),
    ):
        await _process_webhook_event(
            session, "app", "pull_request", payload, 123, delivery,
            gate_check_publish=_gate_check_publish,
        )

    assert len(_gate_check_publish) == 1
    assert _gate_check_publish[0]["gate_id"] == gate_id
    assert _gate_check_publish[0]["org_id"] == org_id
