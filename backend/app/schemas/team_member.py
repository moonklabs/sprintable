import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from pydantic import BaseModel, ConfigDict, computed_field

_ONLINE_THRESHOLD = timedelta(minutes=5)
_IDLE_THRESHOLD = timedelta(minutes=30)


class ActiveStorySummary(BaseModel):
    id: uuid.UUID
    title: str
    status: str


class TeamMemberCreate(BaseModel):
    project_id: uuid.UUID
    org_id: uuid.UUID
    type: str  # 'human' | 'agent'
    name: str
    role: str = "member"
    user_id: uuid.UUID | None = None
    avatar_url: str | None = None
    agent_config: dict[str, Any] | None = None
    color: str = "#3385f8"
    agent_role: str | None = None


class OrgAgentCreate(BaseModel):
    """org-level 에이전트 생성 요청. 단일 project 종속이 아니라 scope_mode 로 프로젝트 집합 지정.

    scope_mode='org'   → org 의 현재 모든 프로젝트에 grant (v1; 미래 프로젝트 자동 grant 는 follow-up).
    scope_mode='projects' → project_ids 에 명시한 프로젝트에만 grant (≥1 필수, 모두 org 소속).
    role 은 grant 별 부여(기본 member) — project_access.role 로 per-project 적용.
    """
    name: str
    role: str = "member"
    agent_config: dict[str, Any] | None = None
    agent_role: str | None = None
    color: str = "#3385f8"
    avatar_url: str | None = None
    scope_mode: str = "projects"  # 'org' | 'projects'
    project_ids: list[uuid.UUID] = []


class TeamMemberUpdate(BaseModel):
    name: str | None = None
    role: str | None = None
    avatar_url: str | None = None
    agent_config: dict[str, Any] | None = None
    color: str | None = None
    agent_role: str | None = None
    is_active: bool | None = None
    can_manage_members: bool | None = None
    runtime_type: str | None = None  # E-CHAT-CMD S1b: 에이전트 런타임 PATCH(anchor=members)


class TeamMemberResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    org_id: uuid.UUID
    user_id: uuid.UUID | None = None
    type: str
    name: str
    role: str
    avatar_url: str | None = None
    agent_config: dict[str, Any] | None = None
    is_active: bool
    color: str
    agent_role: str | None = None
    runtime_type: str | None = None  # E-CHAT-CMD S1b: members.runtime_type 투영(0106 뷰)
    created_by: uuid.UUID | None = None
    can_manage_members: bool = False
    created_at: datetime
    updated_at: datetime
    # S2-1: Presence 필드
    last_seen_at: datetime | None = None
    active_story_id: uuid.UUID | None = None
    agent_status: str | None = None
    # S2-4: active_story 요약 — router에서 inject
    active_story: ActiveStorySummary | None = None

    # S2-3: computed presence_status — 조회 시점 실시간 계산
    @computed_field
    @property
    def presence_status(self) -> str | None:
        if self.type == "human":
            return None
        if self.last_seen_at is None:
            return "offline"
        last = self.last_seen_at
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        delta = datetime.now(timezone.utc) - last
        if delta <= _ONLINE_THRESHOLD:
            return "online"
        if delta <= _IDLE_THRESHOLD:
            return "idle"
        # AC7: claim 중이면 offline 강등 방지 → idle 유지
        if self.active_story_id is not None:
            return "idle"
        return "offline"
