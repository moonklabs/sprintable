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


def test_extra_fields_ignored():
    args = ListStoriesInput(unknown_field="should_be_ignored")
    assert not hasattr(args, "unknown_field")


def test_sprintable_input_base():
    base = SprintableInput()
    assert base.model_config.get("extra") == "ignore"
