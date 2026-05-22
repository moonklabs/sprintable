"""Event taxonomy — canonical parameter schema for all workflow events."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class EventParam:
    key: str
    type: str  # "str" | "bool" | "uuid"
    required: bool
    description: str


EVENT_TAXONOMY: dict[str, list[EventParam]] = {
    "story.status_changed": [
        EventParam("story_id", "uuid", True, "스토리 UUID"),
        EventParam("story_title", "str", True, "스토리 제목"),
        EventParam("old_status", "str", True, "변경 전 상태"),
        EventParam("status", "str", True, "변경 후 상태"),
        EventParam("project_id", "uuid", True, "프로젝트 UUID"),
        EventParam("org_id", "uuid", True, "조직 UUID"),
        EventParam("actor_id", "uuid", False, "실행자 team_member UUID"),
        EventParam("timestamp", "str", True, "ISO 8601 UTC 타임스탬프"),
    ],
    "story.assignee_changed": [
        EventParam("story_id", "uuid", True, "스토리 UUID"),
        EventParam("story_title", "str", True, "스토리 제목"),
        EventParam("assignee_id", "uuid", False, "새 담당자 UUID"),
        EventParam("old_assignee_id", "uuid", False, "기존 담당자 UUID"),
        EventParam("project_id", "uuid", True, "프로젝트 UUID"),
        EventParam("org_id", "uuid", True, "조직 UUID"),
        EventParam("actor_id", "uuid", False, "실행자 team_member UUID"),
        EventParam("timestamp", "str", True, "ISO 8601 UTC 타임스탬프"),
    ],
    "manual_trigger": [
        EventParam("story_id", "str", True, "트리거된 스토리 UUID"),
        EventParam("actor_id", "uuid", False, "실행자 user UUID"),
    ],
}


def validate_event_context(event_type: str, metadata: dict) -> list[str]:
    """Returns list of missing required keys. Empty = valid."""
    schema = EVENT_TAXONOMY.get(event_type, [])
    return [p.key for p in schema if p.required and p.key not in metadata]
