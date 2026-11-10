"""story #4888 (UI-5 P1, PO 11-10) — the person sees «goal», not «epic»: the two texts the backend MAKES at run time.

«Goal» and «epic» are the same data (one router served under /api/v2/goals and /api/v2/epics — the hierarchy rename, story 1925); the front already says «목표». Two texts the server writes were left:
the seed description of the system trigger type «kickoff», and the dispatch a gate-approved goal transition sends to the goal's assignee (title default «epic», content «[epic done] …»).
Stored keys stay as they are (`source_entity_type="epic"`, the trigger metadata `reason`, the slug `kickoff`) — only the words a person reads change.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.repositories.workflow_trigger_type import SYSTEM_TRIGGER_TYPES


def test_the_system_trigger_seed_says_goal_and_no_description_says_epic():
    by_slug = {t["slug"]: t for t in SYSTEM_TRIGGER_TYPES}
    assert by_slug["kickoff"]["description"] == "스프린트 또는 목표 킥오프"
    assert [t["slug"] for t in SYSTEM_TRIGGER_TYPES if "에픽" in (t["description"] or "") or "epic" in (t["description"] or "").lower()] == []
    assert by_slug["kickoff"]["slug"] == "kickoff"  # the stored key does not move


def _session_with(goal):
    result = SimpleNamespace(scalar_one_or_none=lambda: goal)
    return SimpleNamespace(execute=AsyncMock(return_value=result), flush=AsyncMock())


def _step_run(goal, to_status="done", from_status="active"):
    return SimpleNamespace(
        org_id=uuid.uuid4(), entity_id=goal.id, to_status=to_status, from_status=from_status, status="gate_pending", resolved_at=None,
    )


@pytest.mark.anyio
@pytest.mark.parametrize("title, expected_title, expected_content", [
    ("출시 준비", "출시 준비", "[goal done] 출시 준비"),
    (None, "goal", "[goal done]"),
])
async def test_the_dispatch_to_the_goal_assignee_says_goal(monkeypatch, title, expected_title, expected_content):
    from app.services import goal as goal_service
    from app.services import workflow_line_resolution as wlr

    monkeypatch.setattr(goal_service, "transition_goal", AsyncMock())
    sent = {}

    async def _fake_dispatch(session, org_id, member_id, **kw):
        sent.update(kw)
        return {"agent_wake": {"recipient_id": str(member_id)}}

    monkeypatch.setattr(wlr, "_schedule_member_dispatch", _fake_dispatch)
    goal = SimpleNamespace(id=uuid.uuid4(), status="active", title=title, assignee_id=uuid.uuid4(), project_id=uuid.uuid4())
    payload = await wlr._apply_epic_transition(_session_with(goal), _step_run(goal), resolver_id=uuid.uuid4())

    assert payload is not None
    assert sent["title"] == expected_title and sent["content"] == expected_content
    assert "epic" not in sent["title"].lower() and "epic" not in sent["content"].lower()
    # the keys that are STORED / matched by code stay as they were
    assert sent["source_entity_type"] == "epic" and sent["trigger_metadata"]["reason"] == "epic_done" and sent["trigger_metadata"]["source"] == "workflow_line"


# ─── the window between the migration and the swap of the old backend ───────────────────────────────────────────────────────────────

def _row(slug, description, is_system):
    return SimpleNamespace(slug=slug, description=description, is_system=is_system)


def _repo_listing(rows):
    from app.repositories.workflow_trigger_type import WorkflowTriggerTypeRepository

    result = SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: list(rows)))
    session = SimpleNamespace(execute=AsyncMock(return_value=result), flush=AsyncMock())
    return WorkflowTriggerTypeRepository(session, uuid.uuid4()), session


@pytest.mark.anyio
async def test_list_corrects_a_system_row_that_still_carries_the_old_text_and_only_that_row():
    """The migration runs BEFORE the old backend is swapped out: in that window the old release can seed a new organization with the old text. `list()` closes it with the
    migration's own rule — a system row whose description is EXACTLY the old seed text; a description a person edited and a custom row with the same words stay."""
    old = "스프린트 또는 에픽 킥오프"
    stuck, edited, custom, other = _row("kickoff", old, True), _row("kickoff2", "우리 팀 킥오프(에픽 포함)", True), _row("mine", old, False), _row("review_request", "코드 리뷰 요청", True)
    repo, session = _repo_listing([stuck, edited, custom, other])
    items = await repo.list()
    assert [i.description for i in items] == ["스프린트 또는 목표 킥오프", "우리 팀 킥오프(에픽 포함)", old, "코드 리뷰 요청"]
    assert session.flush.await_count == 1


@pytest.mark.anyio
async def test_list_writes_nothing_when_no_row_carries_the_old_text():
    repo, session = _repo_listing([_row("kickoff", "스프린트 또는 목표 킥오프", True)])
    await repo.list()
    assert session.flush.await_count == 0


@pytest.mark.anyio
async def test_linking_a_hypothesis_to_a_goal_of_another_project_is_refused_in_words_that_say_goal():
    from app.services.hypothesis import HypothesisServiceError, _assert_targets_same_project

    mine, other_project, goal = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    session = SimpleNamespace(execute=AsyncMock(return_value=SimpleNamespace(all=lambda: [(goal, other_project)])))
    with pytest.raises(HypothesisServiceError) as caught:
        await _assert_targets_same_project(session, mine, [goal], [])
    assert caught.value.code == "CROSS_PROJECT_LINK_FORBIDDEN"
    assert caught.value.message == "다른 프로젝트의 목표에는 연결할 수 없습니다." and "에픽" not in caught.value.message


@pytest.fixture
def anyio_backend():
    return "asyncio"
