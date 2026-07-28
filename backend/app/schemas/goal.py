import uuid
from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, computed_field

# 계층 리네이밍 B1(story 1925): 구 epic.py — 클래스/필드명만 rename, DB 컬럼(stories.epic_id 등)은
# B4 후속(스코프 밖). 구 이름(GoalXxx의 별칭)은 REST/MCP 레이어(routers/goals.py·sprintable_mcp)에서
# 서빙 — 이 스키마 파일 자체엔 구 클래스명 재노출 없음(내부 타입, 외부 계약 아님).
GOAL_STATUSES = ("draft", "active", "done", "archived")
GOAL_PRIORITIES = ("critical", "high", "medium", "low")

# E-DG S25: goal(구 epic) decision lifecycle 전이규칙. ⭐draft→active·active→done 만 line
# overlay-gated(나머지 archive 류는 native 직행). hypothesis _VALID_TRANSITIONS 패턴 미러.
_GOAL_VALID_TRANSITIONS: set[tuple[str, str]] = {
    ("draft", "active"),       # activation(human-gate overlay)
    ("active", "done"),        # completion(aggregate-gate overlay)
    ("active", "archived"),    # native
    ("done", "archived"),      # native
    ("draft", "archived"),     # native
}


def is_valid_goal_transition(from_status: str, to_status: str) -> bool:
    return (from_status, to_status) in _GOAL_VALID_TRANSITIONS


class GoalCreate(BaseModel):
    project_id: uuid.UUID
    org_id: uuid.UUID
    title: str
    status: str = "active"
    priority: str = "medium"
    description: str | None = None
    objective: str | None = None
    success_criteria: str | None = None
    target_sp: int | None = None
    target_date: date | None = None
    success_hypothesis: str | None = None
    metric_definition: dict[str, Any] | None = None
    measure_after: datetime | None = None


class GoalUpdate(BaseModel):
    title: str | None = None
    status: str | None = None
    priority: str | None = None
    description: str | None = None
    objective: str | None = None
    success_criteria: str | None = None
    target_sp: int | None = None
    target_date: date | None = None
    assignee_id: uuid.UUID | None = None
    success_hypothesis: str | None = None
    metric_definition: dict[str, Any] | None = None
    measure_after: datetime | None = None
    # ⚠️RC#2(D1'): status 는 잔류하되 update_goal 엔드포인트가 **미변경이면 무시·변경 시 422**(전용
    # /transition 강제). FE always-send(미변경 동봉) 호환·실제 status 변경만 차단(RC#1 resolver_id 동형).


class GoalResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    org_id: uuid.UUID
    assignee_id: uuid.UUID | None = None
    title: str
    status: str
    priority: str
    description: str | None = None
    objective: str | None = None
    success_criteria: str | None = None
    target_sp: int | None = None
    target_date: date | None = None
    success_hypothesis: str | None = None
    metric_definition: dict[str, Any] | None = None
    measure_after: datetime | None = None
    outcome_status: str = "n_a"
    outcome_result: dict[str, Any] | None = None
    # E1 S8b: 연결 가설 집계(list 응답서 N+1 없이 부착). additive — 링크 0건이면
    # count 0 / risky None. risky_status는 최위험 1개(falsified>measuring>active>
    # proposed>verified>killed>archived). 미부착 경로(get/create/update)는 기본값.
    hypothesis_count: int = 0
    risky_status: str | None = None
    # 0d4c89e8: 연결 스토리 집계(list 응답서 N+1 없이 부착·hypothesis_count 동형). additive —
    # 스토리 0건이면 0/0. FE 목표 카드(total/done)가 이 필드 바인딩(stories 배열 미부착·payload
    # bloat 방지). 미부착 경로(get/create/update)는 기본값. detail은 별도 /progress 유지.
    total_stories: int = 0
    done_stories: int = 0
    # E-GLANCE wedge #2(story 96b19bc3): 로드맵 조타 큐레이션(Story.position 동형) — null=아직
    # 큐레이션 안 됨. source_loop_id는 계보 인터페이스뿐(배선은 P3 후속).
    position: int | None = None
    source_loop_id: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime

    # story #2282(E-CONNECT) AC1/AC2: 이 goal(=epic, entity_type 문자열은 registry 기준
    # "epic" — reference_registry._resolve_epics가 Goal 모델을 쓴다)을 가리키는 참조 토큰.
    @computed_field  # type: ignore[prop-decorator]
    @property
    def reference_token(self) -> str | None:
        from app.services.reference_token import build_reference_token
        return build_reference_token("epic", self.id, self.title)


class GlanceFocalStory(BaseModel):
    """story #2298(3단 웨이터폴 근절) — `pickFocalStory`(FE `hero-logic.ts`) 규칙을 서버로
    이관한 결과. gate_status는 in-progress 후보들 중 하나라도 pending gate가 있으면 그
    story가 우선 선택되고("gate-우선"), 이 필드엔 그 pending 게이트가 있었는지만 담는다
    (전체 gate 목록은 안 실음 — 이 필드가 실제로 쓰이는 axis 하나뿐이라 과확장 금지).

    ⛔이 규칙은 FE 원본에도 있었지만 `/api/stories?epic_id=` 응답에 `gates` 필드 자체가
    없어(전 코드베이스 grep 확인, `StoryResponse`에 그 필드 없음) 실제로는 단 한 번도
    평가된 적이 없다(2026-07-12 story dee92c96 도입 이래 죽어있던 분기 — git log -S로 확인,
    "언제부터 회귀했는지"가 아니라 "애초에 재료가 없었다"). 여기서 되살리면 동작이 바뀐다 —
    지금까지는 항상 in-progress 중 첫 번째였고, 이제부터 gate-pending이 우선한다. 조용히
    바꾸지 않는다(PR 본문에 명시)."""
    id: uuid.UUID
    title: str
    status: str
    assignee_id: uuid.UUID | None
    gate_status: str | None


class GoalWithGlanceResponse(GoalResponse):
    """story #2298 AC — `?include=glance` 옵트인 전용 응답(기본 `GoalResponse`와 별도 모델
    이유: 파라미터 없을 때 기존 응답이 byte-identical이어야 하는 계약이라, 같은 모델에
    optional 필드를 얹으면 기본값이라도 JSON에 항상 찍혀 계약이 깨진다 — 그래서 라우터가
    두 모델을 분기해 반환한다).

    participant_ids: 이 goal(에픽)에 연결된 story들의 고유 assignee_id 집합(FE
    `deriveCollaboration` 이관 — "참여=presence만, 개수 집계 0"과 동일 의미. 집합 계산이라
    부분 반환("N건 더")이 불가능 — 캡을 두면 그 자체로 값이 틀려진다, 그래서 캡을 두지 않는다."""
    participant_ids: list[uuid.UUID] = []
    focal_story: GlanceFocalStory | None = None


class GoalProgressResponse(BaseModel):
    goal_id: uuid.UUID
    total_stories: int
    done_stories: int
    total_sp: int
    done_sp: int
    completion_pct: int
