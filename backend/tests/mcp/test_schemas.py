"""S2-1: Pydantic BaseModel 입력 스키마 검증 테스트."""
from __future__ import annotations

import pytest

from sprintable_mcp.schemas import SprintableInput, StoryPriority, StoryStatus
from sprintable_mcp.tools.stories import ListStoriesInput


def test_list_stories_input_defaults():
    args = ListStoriesInput()
    assert args.sprint_id is None
    assert args.epic_id is None
    assert args.status is None
    assert args.priority is None
    assert args.assignee_id is None


def test_list_stories_input_with_values():
    args = ListStoriesInput(
        sprint_id="sprint-1",
        epic_id="epic-1",
        status=StoryStatus.in_progress,
        priority=StoryPriority.high,
        assignee_id="member-1",
    )
    assert args.sprint_id == "sprint-1"
    assert args.epic_id == "epic-1"
    assert args.status == StoryStatus.in_progress
    assert args.priority == StoryPriority.high
    assert args.assignee_id == "member-1"


def test_story_status_enum_values():
    assert StoryStatus.backlog == "backlog"
    assert StoryStatus.in_progress == "in-progress"
    assert StoryStatus.in_review == "in-review"
    assert StoryStatus.done == "done"


def test_story_priority_enum_values():
    assert StoryPriority.critical == "critical"
    assert StoryPriority.high == "high"
    assert StoryPriority.medium == "medium"
    assert StoryPriority.low == "low"


def test_extra_fields_rejected():
    """story #2412 AC2 — 예전엔 미선언 필드를 조용히 버렸다(hasattr()이 False가 되는 식으로만
    드러남, 호출자에겐 무증상). 이제는 구성 시점에 ValidationError로 거부한다."""
    with pytest.raises(ValueError):
        ListStoriesInput(unknown_field="should_be_rejected")


def test_sprintable_input_base():
    """story #2412 AC2 — extra="ignore"→"forbid". (실제 MCP 호출 경로의 삼킴은 이 한 겹
    앞(FastMCP 내부 arg_model, server.py::_lock_down_extra_args)에서 막힌다 — 여기는
    defense-in-depth, 직접 `SprintableInput(**kwargs)` 구성 경로까지 잠근다.)"""
    base = SprintableInput()
    assert base.model_config.get("extra") == "forbid"
