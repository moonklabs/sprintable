from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from pydantic import BaseModel


class SprintsOverview(BaseModel):
    total: int
    active: int


class StoriesOverview(BaseModel):
    total: int
    done: int
    total_points: int


class MemosOverview(BaseModel):
    total: int
    open: int


class MembersOverview(BaseModel):
    total: int
    humans: int
    agents: int


class ProjectOverviewResponse(BaseModel):
    sprints: SprintsOverview
    epics: int
    stories: StoriesOverview
    tasks: int
    memos: MemosOverview
    members: MembersOverview


class StoriesWorkload(BaseModel):
    total: int
    in_progress: int
    points: int


class TasksWorkload(BaseModel):
    total: int
    in_progress: int


class MemberWorkloadResponse(BaseModel):
    stories: StoriesWorkload
    tasks: TasksWorkload


class SprintVelocityItem(BaseModel):
    id: uuid.UUID
    title: str
    velocity: int | None
    status: str
    start_date: date | None
    end_date: date | None


class RecentStory(BaseModel):
    id: uuid.UUID
    title: str
    status: str
    updated_at: datetime


class RecentMemo(BaseModel):
    id: uuid.UUID
    title: str | None
    status: str
    created_at: datetime


class RecentAgentRun(BaseModel):
    id: uuid.UUID
    agent_id: uuid.UUID
    trigger: str
    status: str
    created_at: datetime


class RecentActivityResponse(BaseModel):
    recent_stories: list[RecentStory]
    recent_memos: list[RecentMemo]
    recent_agent_runs: list[RecentAgentRun]


class EpicProgressResponse(BaseModel):
    total_stories: int
    done_stories: int
    total_points: int
    done_points: int
    completion_pct: int


class AgentStatsResponse(BaseModel):
    total_runs: int
    completed: int
    failed: int
    total_tokens: int
    total_cost_usd: float
    avg_duration_ms: int


class ActiveSprintInfo(BaseModel):
    id: uuid.UUID
    title: str
    start_date: date | None
    end_date: date | None


class ProjectHealthResponse(BaseModel):
    active_sprint: ActiveSprintInfo | None
    sprint_progress: int
    open_memos: int
    unassigned_stories: int
    health: str


class BurndownPoint(BaseModel):
    date: str
    points: int


class SprintInfo(BaseModel):
    id: uuid.UUID
    title: str
    status: str
    start_date: date | None
    end_date: date | None
    duration: int
    velocity: int | None


class BurndownResponse(BaseModel):
    sprint: SprintInfo
    total_points: int
    done_points: int
    remaining_points: int
    completion_pct: int
    stories_count: int
    done_count: int
    ideal_line: list[BurndownPoint]
    actual_line: list[BurndownPoint]


class SprintVelocityResponse(BaseModel):
    velocity: int | None
    title: str
    status: str


class LeaderboardEntry(BaseModel):
    member_id: uuid.UUID
    balance: float
