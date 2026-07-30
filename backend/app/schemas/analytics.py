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


class EpicProgressLane(BaseModel):
    """story #2224(S2-1) 좌측 레인 — 미르코 실측 갭. 다섯 칸이 서로 겹치지 않게 우선순위로
    정리한다(막힘>대기>진행>멈춤>other, AnalyticsRepository.get_epics_progress_lane 참조).
    ⛔`other`(PO 지적, 2026-07-30): 「합계≠total_stories는 의도했어도 화면에서는 거짓말이
    된다」— done, 또는 backlog/ready-for-dev/in-review 중 최근(168h 이내) 변경된 것이 여기
    든다. in_progress+waiting+blocked+stalled+other는 그 에픽의 total_stories와 항상 같다."""
    in_progress: int
    waiting: int
    blocked: int
    stalled: int
    other: int


class EpicsProgressLaneResponse(BaseModel):
    """{epic_id(str): EpicProgressLane} — project 전체 에픽을 «한 번의 호출»로 낸다(N+1 회피).
    ⛔잠정치: 멈춤 임계 168h는 #2218(S0-1) 재측정 전까지의 값.

    ⛔`stories_without_epic`(PO 판정 2026-07-30, dev 실측 445건 후 뒤집힘): 에픽 없음은
    결함이 아니라 «사실»이다(445건이면 손으로 붙일 수 있는 규모가 아니다 — 「미배정」
    레인은 여전히 안 만든다, 다만 이유가 바뀌었다: "나쁜 습관을 굳힐까 봐"에서 "445를
    한 줄에 담으면 그게 제일 큰 줄이 되어 화면을 먹는다"로). 화면이 «거짓말만 안 하면»
    된다 — 좌 레인 합계를 project 전체인 것처럼 보이지 않는다. 그래서 이 수를 응답에
    실어 화면이 "에픽에 속한 것만 여기 있습니다 · 나머지 N건은 이 레인 밖입니다"를
    말할 수 있게 한다."""
    epics: dict[str, EpicProgressLane]
    stall_threshold_hours: int
    stories_without_epic: int


class AgentStatsResponse(BaseModel):
    # S2-1 신규 지표 (stories 기반)
    completed: int
    total_stories: int = 0
    done_story_points: int = 0
    avg_lead_time_ms: int = 0
    # 하위 호환 필드 (기본값 0으로 안전하게 유지)
    total_runs: int = 0
    failed: int = 0
    total_tokens: int = 0
    total_cost_usd: float = 0.0
    avg_duration_ms: int = 0


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
