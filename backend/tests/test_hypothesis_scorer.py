"""E1-S4: Hypothesis scorer 단위 테스트 (블루프린트 §8.3·§2.5).

핵심 불변식: active→measuring(measure_after 도래)→verified/falsified(hit/miss)·GA4 실패/미지원
source는 measuring 유지(거짓 신호 차단)·legacy outcome_scorer 무영향(hypotheses 테이블만).
"""
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import hypothesis_scorer as sc


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _mock_outcome_verdicts():
    """HO-S4: scorer가 해소 직후 record_outcome_verdicts를 호출하므로, 전이 로직만 검증하는 기존
    테스트(mock session)에서는 배선 호출을 격리한다(scorer 불변식 어서션 유지·AC③)."""
    with patch(
        "app.services.hypothesis_outcome_verdict.record_outcome_verdicts",
        new=AsyncMock(return_value={"skipped_reason": "no_linked_story", "bet": [], "execution": []}),
    ):
        yield


@pytest.fixture(autouse=True)
def _mock_loop_attribution():
    """E-LOOP-LEDGER S7: scorer가 해소 직후 attribute_loop_outcome도 호출하므로(추가 session.execute
    1회), _mock_outcome_verdicts와 동일 이유로 전이 로직만 검증하는 기존 테스트에서 격리한다."""
    with patch(
        "app.services.loop_outcome_attribution.attribute_loop_outcome",
        new=AsyncMock(return_value={"skipped_reason": "no_measuring_loop", "attributed": []}),
    ):
        yield


def _hyp(status="active", source="ga4", **ov):
    md = {"metric": "signups", "source": source, "target": 100, "direction": "up"}
    base = dict(
        id=uuid.uuid4(), status=status, metric_definition=md,
        measure_after=datetime(2026, 1, 1, tzinfo=timezone.utc), outcome_result=None,
    )
    base.update(ov)
    return SimpleNamespace(**base)


def _result(items):
    r = MagicMock()
    r.scalars.return_value.all.return_value = items
    return r


def _session(execute_results):
    s = AsyncMock()
    s.execute = AsyncMock(side_effect=execute_results)
    s.commit = AsyncMock()
    return s


async def _run(hyps, *, ga4=None, epic=None, story_statuses=None):
    # 첫 execute = hyps 목록. internal_ops면 두 번째 execute = 링크 스토리 상태.
    results = [_result(hyps)]
    if story_statuses is not None:
        results.append(_result(story_statuses))
    session = _session(results)
    patches = []
    if ga4 is not None:
        patches.append(patch.object(sc, "score_ga4_outcome", side_effect=ga4 if callable(ga4) else MagicMock(return_value=ga4)))
    if epic is not None:
        patches.append(patch.object(sc, "score_epic_outcome", MagicMock(return_value=epic)))
    for p in patches:
        p.start()
    try:
        return await sc.score_hypotheses(session)
    finally:
        for p in patches:
            p.stop()


async def test_active_ga4_hit_to_verified():
    h = _hyp(status="active", source="ga4")
    summary = await _run([h], ga4={"outcome_status": "hit", "outcome_result": {"actual": 120}})
    assert h.status == "verified" and h.outcome_result == {"actual": 120}
    assert str(h.id) in summary["to_measuring"] and str(h.id) in summary["verified"]


async def test_active_ga4_miss_to_falsified():
    h = _hyp(status="active", source="ga4")
    summary = await _run([h], ga4={"outcome_status": "miss", "outcome_result": {"actual": 10}})
    assert h.status == "falsified"
    assert str(h.id) in summary["falsified"]


async def test_active_ga4_pending_stays_measuring():
    h = _hyp(status="active", source="ga4")
    summary = await _run([h], ga4={"outcome_status": "pending", "outcome_result": None})
    assert h.status == "measuring"  # active→measuring, 채점은 pending이라 유지
    assert str(h.id) in summary["to_measuring"] and str(h.id) in summary["pending"]


async def test_measuring_ga4_hit_no_double_to_measuring():
    h = _hyp(status="measuring", source="ga4")
    summary = await _run([h], ga4={"outcome_status": "hit", "outcome_result": {}})
    assert h.status == "verified"
    assert str(h.id) not in summary["to_measuring"]  # 이미 measuring
    assert str(h.id) in summary["verified"]


async def test_manual_source_stays_measuring():
    h = _hyp(status="active", source="manual")
    summary = await _run([h])  # ga4 미패치 — manual은 호출 안 함
    assert h.status == "measuring"
    assert str(h.id) in summary["pending"]


async def test_ga4_exception_keeps_measuring_and_records_failed():
    h = _hyp(status="active", source="ga4")
    def boom(_md):
        raise RuntimeError("GA4 회수 실패")
    summary = await _run([h], ga4=boom)
    assert h.status == "measuring"  # 위장 금지 — 실패는 verified/falsified로 안 떨어뜨림
    assert summary["failed"] and summary["failed"][0]["id"] == str(h.id)


async def test_internal_ops_completion_scores_via_epic_helper():
    h = _hyp(status="active", source="internal_ops",
             metric_definition={"metric": "completion_pct", "source": "internal_ops", "target": 80, "direction": "up"})
    # 링크 스토리 3개 중 2 done → pct 계산은 실DB 스모크에서, 여기선 epic helper 반환만 검증
    summary = await _run([h], story_statuses=["done", "done", "backlog"],
                         epic={"outcome_status": "hit", "outcome_result": {"actual": 66.67}})
    assert h.status == "verified"
    assert str(h.id) in summary["verified"]


def test_outcome_to_status_mapping():
    assert sc._OUTCOME_TO_STATUS == {"hit": "verified", "miss": "falsified"}
