"""L2-S7: 끝단 E2E — status_changed 활동 1건 → 정확히 1 wake.

블루프린트 §5 S7·§6. fake `poll_activities_after_seq`로 status_changed 활동을 주입하고 전 체인
(adapter→evaluator→dedup→dispatch→wake)을 실제로 태운다(외부 의존만 fake). DB변경 0.

AC: ①fake poll status_changed → 정확히 1 Event(dispatched) ②recipient_seq 有·commit 후 wake_agent
1회 ③payload에 trigger_metadata+anchor ④같은 activity 재처리 무추가 wake(dedup) ⑤LLM import/call 0.
"""
from __future__ import annotations

import inspect
import uuid
from contextlib import ExitStack
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import agent_dispatch as dispatch_mod
from app.services import conversation_webhook as webhook_mod
from app.services.l1_activity_source import ActivitySignal
from app.services.l2_trigger_worker import L2TriggerWorker


@pytest.fixture
def anyio_backend():
    return "asyncio"


ORG = uuid.uuid4()
STORY_ID = uuid.uuid4()
ASSIGNEE = uuid.uuid4()
PROJECT = uuid.uuid4()


def _status_changed_signal(seq: int = 101) -> ActivitySignal:
    return ActivitySignal(
        activity_seq=seq,
        activity_id=uuid.uuid4(),
        org_id=ORG,
        project_id=PROJECT,
        verb="status_changed",
        occurred_at=datetime(2026, 6, 12, tzinfo=timezone.utc),
        object_type="story",
        object_id=STORY_ID,
        payload={"to": "in_review"},
    )


async def _assign_seq(_db, event):
    event.recipient_seq = 42  # per-recipient dense seq 모사.


def _chain_patches(worker, added, *, claim_results):
    """전 체인 외부 의존만 fake. evaluator/dedup/dispatch 본체는 실제로 태운다."""
    stack = ExitStack()
    # adapter poll: status_changed 활동 1건 주입(AC①).
    stack.enter_context(
        patch.object(worker.source, "poll_after_seq",
                     AsyncMock(return_value=([_status_changed_signal()], None)))
    )
    stack.enter_context(patch.object(worker, "_read_cursor", AsyncMock(return_value=0)))
    stack.enter_context(patch.object(worker, "_write_cursor", AsyncMock()))
    # dedup claim: 승자/패자 시퀀스(AC④ 재처리).
    stack.enter_context(patch.object(worker, "_claim_firing", AsyncMock(side_effect=claim_results)))
    stack.enter_context(patch.object(worker, "_link_event", AsyncMock()))
    # entity fetch(evaluator + dispatch 공용) → assignee 보유 story.
    stack.enter_context(
        patch.object(dispatch_mod, "_fetch_entity",
                     AsyncMock(return_value=(ASSIGNEE, "로그인 구현", "OAuth", PROJECT)))
    )
    stack.enter_context(
        patch.object(dispatch_mod, "resolve_member_identity",
                     AsyncMock(return_value=SimpleNamespace(id=ASSIGNEE, type="agent")))
    )
    stack.enter_context(patch.object(dispatch_mod, "assign_recipient_seq", _assign_seq))
    stack.enter_context(patch.object(dispatch_mod, "extract_activities_best_effort", AsyncMock()))
    wake = stack.enter_context(patch.object(dispatch_mod, "wake_agent", MagicMock()))
    stack.enter_context(patch("app.services.hypothesis.resolve_dispatch_anchor", AsyncMock(return_value=None)))
    stack.enter_context(patch.object(webhook_mod, "deliver_injected_event_webhook", AsyncMock()))
    return stack, wake


def _make_db(added):
    db = AsyncMock()
    db.add = MagicMock(side_effect=added.append)
    return db


@pytest.mark.anyio
async def test_status_changed_produces_exactly_one_dispatched_event_and_wake():
    worker = L2TriggerWorker(use_advisory_lock=False)
    added: list = []
    db = _make_db(added)
    stack, wake = _chain_patches(worker, added, claim_results=[True])
    with stack:
        await worker._poll_once(db)

    # AC①: 정확히 1 Event(dispatched).
    dispatched = [e for e in added if getattr(e, "event_type", None) == "dispatched"]
    assert len(dispatched) == 1
    ev = dispatched[0]
    assert ev.recipient_type == "agent" and ev.recipient_id == ASSIGNEE

    # AC②: recipient_seq 有 + commit 후 wake_agent 1회.
    assert ev.recipient_seq == 42
    wake.assert_called_once()
    assert wake.call_args.args[0] == str(ASSIGNEE) and wake.call_args.args[1] == 42

    # AC③: payload에 trigger_metadata(L2 출처) + anchor(entity).
    tm = ev.payload["trigger_metadata"]
    assert tm["source"] == "l2_heuristic" and tm["trigger_type"] == "status_changed"
    assert tm["source_activity_seq"] == 101
    assert ev.payload["entity_type"] == "story" and ev.payload["entity_id"] == str(STORY_ID)


@pytest.mark.anyio
async def test_reprocessing_same_activity_no_additional_wake():
    """AC④: 같은 활동을 두 번 처리해도 dedup(같은 dedup_key)이라 추가 wake 0."""
    worker = L2TriggerWorker(use_advisory_lock=False)
    added: list = []
    db = _make_db(added)
    # 1차 승자(True), 2차 dedup 충돌(False).
    stack, wake = _chain_patches(worker, added, claim_results=[True, False])
    with stack:
        await worker._poll_once(db)  # 1차 — wake.
        await worker._poll_once(db)  # 2차 재처리 — dedup 충돌.

    assert len([e for e in added if getattr(e, "event_type", None) == "dispatched"]) == 1
    wake.assert_called_once()  # 추가 wake 0.


def test_dedup_key_deterministic_for_same_activity():
    """같은 활동 신호는 같은 dedup_key → 재처리가 동일 키로 충돌(AC④ 기반)."""
    from app.services.l2_heuristics import TriggerDecision

    d = TriggerDecision("status_changed", ASSIGNEE, "story", STORY_ID, "r", 101)
    assert L2TriggerWorker._dedup_key(d) == L2TriggerWorker._dedup_key(d)
    assert L2TriggerWorker._dedup_key(d).endswith(":a101")


# ── AC⑤: LLM client import/call 0 ──────────────────────────────────────────────

def test_l2_chain_modules_have_no_llm_imports():
    from app.services import l1_activity_source, l2_heuristics, l2_trigger_worker

    forbidden = ("openai", "anthropic", "litellm", "cohere", "google.generativeai", "vertexai")
    for mod in (l2_heuristics, l1_activity_source, l2_trigger_worker):
        src = inspect.getsource(mod)
        for name in forbidden:
            assert f"import {name}" not in src and f"from {name}" not in src, f"{mod.__name__}:{name}"
