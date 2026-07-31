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


class EpicZoneCounts(BaseModel):
    """급추가(2026-07-30, 선생님이 /flow에서 직접 지적) — 화면 상단이 「지나온 것│지금│
    이어질 것」(시간축)을 약속하는데 막대는 그 축을 안 쓰는 진행률(%)이었다. `epic-flow-nodes`가
    이미 확定한 시간축 정의를 그대로 재사용한다(다른 데서 새로 정의하면 "지금"이 두 벌 선다):
    past_cnt=done, now_cnt=in-progress+in-review, upcoming_cnt=나머지(ready-for-dev 포함).
    past_cnt+now_cnt+upcoming_cnt == total 항상 성립."""
    title: str | None
    total: int
    done: int
    pct: int
    past_cnt: int
    now_cnt: int
    upcoming_cnt: int


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
    zones: dict[str, EpicZoneCounts]
    stall_threshold_hours: int
    stories_without_epic: int


class FlowNode(BaseModel):
    """story #2224 노드 계약 — 화면 한 줄에 필요한 만큼만(id·SID·제목·status·담당·마지막
    변화 시각). 7상태 뱃지는 이 필드가 아니라 FE가 status에서 도출(다른 축, PO 판정)."""
    id: uuid.UUID
    story_number: int | None  # allocate_story_number()가 채번 — DB제약은 nullable(모델 참조)
    title: str
    status: str
    assignee_id: uuid.UUID | None
    updated_at: datetime
    # ⛔story #2224 후속(오르테가 판정, 2026-07-31) — 문(게이트) 레이어. gate_pending=False면
    # gate_reason은 항상 None(막히지 않은 노드에 원인이 있으면 거짓말이 된다). AnalyticsRepository
    # ._blocked_story_evidence/_gate_reason이 SSOT — get_epics_progress_lane의 lane["blocked"]와
    # 같은 조건(값을 두 번 안 적는다).
    gate_pending: bool
    gate_reason: str | None


class FlowNodeZone(BaseModel):
    total: int
    items: list[FlowNode]


class FlowNodeUpcomingZone(BaseModel):
    """⛔`shown`(PO 규율 2026-07-30): 잘린 개수를 반드시 함께 낸다 — "없앤 것"이 아니라
    "안 그린 것"이라 말할 수 있게. total > shown이면 화면이 "N건 중 M건 표시"를 말한다."""
    total: int
    shown: int
    items: list[FlowNode]


class FlowNodePastZone(BaseModel):
    """지나온(done) 것은 노드로 안 그린다 — 수로만 접는다(PO 판정)."""
    total: int


class EpicFlowNodesResponse(BaseModel):
    """GET .../epic-flow-nodes?epic_id=... — 한 에픽 단위(179개 에픽 전체를 한 번에 주면
    수천 건이라 응답이 죽는다, dev 실측 최대 141건/에픽). 세 구역(지금·이어질·지나온)은
    «시간»축이지 7상태(실행가능·검증필요…) 축이 아니다 — 섞으면 같은 것을 두 번 말한다."""
    epic_id: uuid.UUID
    now: FlowNodeZone
    upcoming: FlowNodeUpcomingZone
    past: FlowNodePastZone
    # ⛔story #2679 후속(2026-07-30) — /flow 초점 스트립 4종 수치 중 둘. blocked_count는
    # get_epics_progress_lane의 lane["blocked"]와 같은 Gate 필터(status 무관, 형제 화면과
    # 안 갈림). last_changed_at은 「마지막 변경 이후」다 — 「마지막 머지/배포 이후」가 옳은
    # 정의이나 그 소스가 없어(merged_at 미저장·배포 추적 테이블 없음) 이름을 좁혀 낸다.
    blocked_count: int
    last_changed_at: datetime | None


class EpicFlowNodesBatchResponse(BaseModel):
    """story #2679(2026-07-30) — GET .../epic-flow-nodes?epic_ids=a,b,c. L3 캔버스가 여러
    레인을 한 화면에 동시에 그리며 단일-에픽 계약이 레인 수만큼 호출을 요구하게 됐다
    (오늘 금지한 패턴) — FE가 이미 아는 epic_id 목록을 넘겨 한 번에 받는다.
    ⛔epic_ids가 상한(EPIC_FLOW_NODES_BATCH_MAX)을 넘으면 앞 N개만 처리되고 나머지는
    skipped_epic_ids에 실린다("없앤 것"이 아니라 "안 그린 것" — 오늘 규율 그대로)."""
    epics: list[EpicFlowNodesResponse]
    requested_count: int
    processed_count: int
    skipped_epic_ids: list[uuid.UUID]


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


class GoalEdge(BaseModel):
    """story #2360 — 목표(에픽) 쌍을 잇는 「낳음」 연결의 집계 한 행. `count`는 그 목표
    쌍을 잇는 «스토리 쌍»의 수(같은 스토리 쌍이 두 소스 표 모두에 걸려 있어도 1로 센다).
    `kind`는 그 목표 쌍의 관계 종류가 단일값일 때만 채워지고, 섞이거나(created_from처럼
    종류 축이 없는 것과 declared가 섞이는 경우 포함) 없으면 None이다."""

    from_goal_id: uuid.UUID
    to_goal_id: uuid.UUID
    count: int
    kind: str | None = None
