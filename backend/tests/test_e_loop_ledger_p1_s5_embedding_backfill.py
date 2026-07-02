"""E-LOOP-LEDGER P1-S5: embedding backfill 서비스 단위 테스트(mock session, 블루프린트 §P1).

핵심 불변식: archived hypothesis/soft-deleted loop/그 소속 artifact는 스캔 대상에서 제외(orphan
낭비 방지) — enqueue_embedding은 P1-S4에서 이미 검증됐으므로 여기선 patch해 "무엇을 몇 번 어떤
인자로 호출했는지"만 검증한다. loop_artifact는 decision 상태에 맞는 이유만 텍스트에 반영.
"""
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import embedding_backfill as backfill


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _hyp(status="active"):
    return SimpleNamespace(
        id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(),
        owner_member_id=uuid.uuid4(), statement="가설 문장", status=status,
    )


def _loop():
    return SimpleNamespace(
        id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(),
        created_by_member_id=uuid.uuid4(), title="루프 제목", goal_tags=["tag1"],
    )


def _artifact(decision="pending", choose_reason=None, rejection_reason=None):
    return SimpleNamespace(
        id=uuid.uuid4(), org_id=uuid.uuid4(), created_by_member_id=uuid.uuid4(),
        variant_label="variant A", decision=decision,
        choose_reason=choose_reason, rejection_reason=rejection_reason,
    )


def _scalars_result(items):
    r = MagicMock()
    r.scalars.return_value.all.return_value = items
    return r


def _rows_result(pairs):
    r = MagicMock()
    r.all.return_value = pairs
    return r


async def test_only_rows_returned_by_query_are_enqueued():
    """세션이 반환한 항목만 enqueue 대상(카운트/인자 매핑 검증) — archived/soft-deleted가 실제로
    SELECT WHERE에서 걸러지는지는 mock으론 증명 불가(쿼리를 실행 안 함) → realdb 테스트 스코프."""
    hyp = _hyp(status="active")
    lp = _loop()
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[
        _scalars_result([hyp]), _scalars_result([lp]), _rows_result([]),
    ])
    with patch("app.services.embedding_enqueue.enqueue_embedding", new=AsyncMock()) as mock_enqueue:
        counts = await backfill.backfill_embeddings(session)
    assert counts == {"hypothesis": 1, "loop": 1, "loop_artifact": 0}
    assert mock_enqueue.await_count == 2
    hyp_call = mock_enqueue.await_args_list[0]
    assert hyp_call.args[3] == "hypothesis" and hyp_call.args[4] == hyp.id


async def test_loop_artifact_project_id_resolved_via_loop_join():
    artifact = _artifact(decision="chosen", choose_reason="가장 좋은 이유")
    project_id = uuid.uuid4()
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[
        _scalars_result([]), _scalars_result([]), _rows_result([(artifact, project_id)]),
    ])
    with patch("app.services.embedding_enqueue.enqueue_embedding", new=AsyncMock()) as mock_enqueue:
        counts = await backfill.backfill_embeddings(session)
    assert counts["loop_artifact"] == 1
    call = mock_enqueue.await_args_list[0]
    assert call.args[1] == artifact.org_id
    assert call.args[2] == project_id  # loop_runs JOIN으로 해소된 project_id.


async def test_artifact_decision_state_gates_which_reason_included():
    chosen = _artifact(decision="chosen", choose_reason="chosen text", rejection_reason="stale")
    rejected = _artifact(decision="rejected", choose_reason="stale", rejection_reason="rejected text")
    pending = _artifact(decision="pending", choose_reason="stale", rejection_reason="stale")
    pid = uuid.uuid4()
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[
        _scalars_result([]), _scalars_result([]),
        _rows_result([(chosen, pid), (rejected, pid), (pending, pid)]),
    ])
    captured_texts = []
    with patch(
        "app.services.embedding_enqueue.build_loop_artifact_embedding_text",
        side_effect=lambda label, cr, rr: captured_texts.append((cr, rr)) or "t",
    ):
        with patch("app.services.embedding_enqueue.enqueue_embedding", new=AsyncMock()):
            await backfill.backfill_embeddings(session)
    assert captured_texts[0] == ("chosen text", None)   # chosen: choose_reason만.
    assert captured_texts[1] == (None, "rejected text")  # rejected: rejection_reason만.
    assert captured_texts[2] == (None, None)             # pending: 둘 다 None.


async def test_empty_scan_returns_zero_counts():
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[
        _scalars_result([]), _scalars_result([]), _rows_result([]),
    ])
    counts = await backfill.backfill_embeddings(session)
    assert counts == {"hypothesis": 0, "loop": 0, "loop_artifact": 0}
