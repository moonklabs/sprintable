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
    # E-GLANCE wedge #2(story 96b19bc3): 로드맵 조타 + 오르테가 이벤트 구독. story.status_changed와
    # 동일 shape(스키마 재사용, 신규 필드 패턴 발명 금지).
    "epic.created": [
        EventParam("epic_id", "uuid", True, "에픽 UUID"),
        EventParam("epic_title", "str", True, "에픽 제목"),
        EventParam("project_id", "uuid", True, "프로젝트 UUID"),
        EventParam("org_id", "uuid", True, "조직 UUID"),
        EventParam("actor_id", "uuid", False, "실행자 team_member UUID"),
        EventParam("timestamp", "str", True, "ISO 8601 UTC 타임스탬프"),
    ],
    "epic.status_changed": [
        EventParam("epic_id", "uuid", True, "에픽 UUID"),
        EventParam("epic_title", "str", True, "에픽 제목"),
        EventParam("old_status", "str", True, "변경 전 상태"),
        EventParam("status", "str", True, "변경 후 상태"),
        EventParam("project_id", "uuid", True, "프로젝트 UUID"),
        EventParam("org_id", "uuid", True, "조직 UUID"),
        EventParam("actor_id", "uuid", False, "실행자 team_member UUID"),
        EventParam("timestamp", "str", True, "ISO 8601 UTC 타임스탬프"),
    ],
    "epic.reordered": [
        EventParam("epic_id", "uuid", True, "에픽 UUID(배치 중 1건 대표 — items에 전체)"),
        EventParam("epic_title", "str", True, "에픽 제목"),
        EventParam("project_id", "uuid", True, "프로젝트 UUID"),
        EventParam("org_id", "uuid", True, "조직 UUID"),
        EventParam("position", "str", True, "변경 후 position(batch=list 직렬화)"),
        EventParam("old_position", "str", False, "변경 전 position(batch=list 직렬화)"),
        EventParam("actor_id", "uuid", False, "실행자 team_member UUID"),
        EventParam("timestamp", "str", True, "ISO 8601 UTC 타임스탬프"),
    ],
    "epic.removed": [
        EventParam("epic_id", "uuid", True, "에픽 UUID"),
        EventParam("epic_title", "str", True, "에픽 제목"),
        EventParam("project_id", "uuid", True, "프로젝트 UUID"),
        EventParam("org_id", "uuid", True, "조직 UUID"),
        EventParam("actor_id", "uuid", False, "실행자 team_member UUID"),
        EventParam("timestamp", "str", True, "ISO 8601 UTC 타임스탬프"),
    ],
    # P0-04(doc trust-pipeline-be-design §4): trust pipeline 6단계 파생 전환. 신규 이벤트는 dot
    # 표기로 통일(기존 story_status_changed 언더스코어 레거시 혼재 정리는 별건 ab9de360).
    "story.trust_stage_changed": [
        EventParam("story_id", "uuid", True, "스토리 UUID"),
        EventParam("project_id", "uuid", True, "프로젝트 UUID"),
        EventParam("org_id", "uuid", True, "조직 UUID"),
        EventParam("old_stage", "str", False, "변경 전 trust stage(unknown/done이면 null)"),
        EventParam("new_stage", "str", False, "변경 후 trust stage(done이면 null·파이프라인 스코프 밖)"),
        EventParam("actor_id", "uuid", False, "실행자 member UUID"),
        EventParam("timestamp", "str", True, "ISO 8601 UTC 타임스탬프"),
    ],
    # E-MCP-OPT(story ff6cb90d·doc mcp-multiproject-scoping-design §3/§7②): 멀티프로젝트 MCP 키의
    # 기본 프로젝트 전환 — updated_at만으론 "무엇→무엇"이 안 남아 감사 목적 신규 이벤트로 보강.
    "member.default_project_changed": [
        EventParam("member_id", "uuid", True, "멤버 UUID"),
        EventParam("org_id", "uuid", True, "조직 UUID"),
        EventParam("old_default_project_id", "uuid", False, "변경 전 기본 프로젝트(미설정이면 null)"),
        EventParam("new_default_project_id", "uuid", True, "변경 후 기본 프로젝트"),
        EventParam("timestamp", "str", True, "ISO 8601 UTC 타임스탬프"),
    ],
    # P0-05 후속(story 174be6bc·doc scope-violation-signal-design §1 확定): 선언 주체 제한 없음(자기신고
    # 허용)이라 도중 축소/해제 회피 경로가 있음 — 이 감사 이벤트가 그 억지력(PO 필수 채택 지시).
    "story.declared_scope_changed": [
        EventParam("story_id", "uuid", True, "스토리 UUID"),
        EventParam("project_id", "uuid", True, "프로젝트 UUID"),
        EventParam("org_id", "uuid", True, "조직 UUID"),
        EventParam("old_declared_scope_paths", "str", False, "변경 전 글롭 배열(JSON 직렬화, 미설정 null)"),
        EventParam("new_declared_scope_paths", "str", False, "변경 후 글롭 배열(JSON 직렬화, 해제 시 null)"),
        EventParam("actor_id", "uuid", False, "실행자 member UUID"),
        EventParam("timestamp", "str", True, "ISO 8601 UTC 타임스탬프"),
    ],
}


def validate_event_context(event_type: str, metadata: dict) -> list[str]:
    """Returns list of missing required keys. Empty = valid."""
    schema = EVENT_TAXONOMY.get(event_type, [])
    return [p.key for p in schema if p.required and p.key not in metadata]
