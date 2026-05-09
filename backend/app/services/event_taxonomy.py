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
    "memo_created": [
        EventParam("memo_id", "uuid", True, "메모 UUID"),
        EventParam("memo_type", "str", True, "메모 타입 (task/memo/request 등)"),
        EventParam("title", "str", False, "메모 제목"),
        EventParam("assigned_to_id", "uuid", False, "수신자 team_member UUID"),
        EventParam("actor_id", "uuid", False, "발신자 team_member UUID"),
    ],
    "memo.reply_created": [
        EventParam("original_memo_id", "uuid", True, "원 메모 UUID"),
        EventParam("original_memo_type", "str", False, "원 메모 타입"),
        EventParam("original_title", "str", False, "원 메모 제목"),
        EventParam("reply_author_id", "uuid", True, "답신자 team_member UUID"),
        EventParam("reply_author_role", "str", False, "답신자 역할 (human/agent/member 등)"),
        EventParam("review_type", "str", False, "리뷰 타입 (approve/request_changes/comment 등)"),
        EventParam("has_pr_link", "bool", False, "답신 본문에 PR 링크 포함 여부"),
        EventParam("content_preview", "str", False, "답신 본문 앞 200자"),
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
