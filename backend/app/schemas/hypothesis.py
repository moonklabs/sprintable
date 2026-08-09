"""E1-S2: Hypothesis Pydantic schemas (블루프린트 §3.2~§3.8).

metric_definition은 기존 Story validator(`_validate_metric_definition`)를 재사용한다 —
{metric, source, target, direction} 공통 필수 + GA4 추가 필수. Hypothesis에서는
metric_definition이 NOT NULL이라 create/transition 경로에서 None을 거부한다.
"""
import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, computed_field, field_validator, model_validator

from app.schemas.story import _validate_metric_definition

# §2.5 상태 7종 (모델 HYPOTHESIS_STATUSES와 동기)
HYPOTHESIS_STATUSES = (
    "proposed", "active", "measuring", "verified", "falsified", "killed", "archived",
)
# transition endpoint가 허용하는 목표 상태(생성 시 proposed는 별도)
TRANSITION_TARGETS = ("active", "measuring", "verified", "falsified", "killed", "archived")
LINK_TYPES = ("primary", "supports")


class HypothesisCreate(BaseModel):
    project_id: uuid.UUID
    statement: str
    metric_definition: dict[str, Any]
    measure_after: datetime
    owner_member_id: uuid.UUID | None = None
    status: str = "proposed"
    epic_ids: list[uuid.UUID] = []
    story_ids: list[uuid.UUID] = []
    # N:1(PO 결) — epic_ids/story_ids와 대칭으로 create-time 링크(a4acc4d0 까심 RC① fix:
    # 이전엔 /links 전용이라 create 시 sprint_id를 줘도 silent drop됐다).
    sprint_id: uuid.UUID | None = None
    source_type: str | None = None
    source_id: uuid.UUID | None = None
    draft_metadata: dict[str, Any] | None = None

    @field_validator("metric_definition")
    @classmethod
    def _check_metric(cls, v: dict[str, Any]) -> dict[str, Any]:
        # NOT NULL — None은 Pydantic 타입에서 이미 거부. 구조는 Story validator 재사용.
        return _validate_metric_definition(v)  # type: ignore[return-value]


class HypothesisUpdate(BaseModel):
    """§3.5 allowlist — status/outcome_result 직접 수정 금지(전이 endpoint 전용)."""
    statement: str | None = None
    metric_definition: dict[str, Any] | None = None
    measure_after: datetime | None = None
    owner_member_id: uuid.UUID | None = None
    confidence: float | None = None
    draft_metadata: dict[str, Any] | None = None
    human_accounting: dict[str, Any] | None = None
    # N:1(PO 결) — hypotheses 컬럼이 아니라 링크 테이블 행이라 서비스가 별도 경로로 처리
    # (repo.update()에 그대로 넘기면 존재하지 않는 컬럼이라 silent no-op). None = 링크 해제.
    sprint_id: uuid.UUID | None = None

    @field_validator("metric_definition")
    @classmethod
    def _check_metric(cls, v: dict[str, Any] | None) -> dict[str, Any] | None:
        return _validate_metric_definition(v)


class HypothesisTransition(BaseModel):
    status: str
    note: str | None = None
    outcome_result: dict[str, Any] | None = None


class HypothesisLinkRequest(BaseModel):
    epic_ids: list[uuid.UUID] = []
    story_ids: list[uuid.UUID] = []
    # N:1(PO 결 2026-07-03) — epic_ids/story_ids와 달리 리스트가 아니라 단일 값.
    # 이미 다른 sprint에 링크돼 있으면 교체(재배정) — HypothesisRepository.set_sprint_link 참고.
    sprint_id: uuid.UUID | None = None
    link_type: str | None = None


class HypothesisUnlinkRequest(BaseModel):
    epic_ids: list[uuid.UUID] = []
    story_ids: list[uuid.UUID] = []
    unlink_sprint: bool = False


class HypothesisResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    owner_member_id: uuid.UUID
    created_by_member_id: uuid.UUID | None = None
    confirmed_by_member_id: uuid.UUID | None = None
    statement: str
    metric_definition: dict[str, Any]
    measure_after: datetime
    status: str
    outcome_result: dict[str, Any] | None = None
    confidence: float | None = None
    source_type: str | None = None
    source_id: uuid.UUID | None = None
    # FE가 "AI 초안 vs 사람 생성 proposed"를 구분(isDraft)해 [활성화] 버튼 게이팅하도록 노출(48dbada0 선행).
    # drafted_by_member_id 존재 = agent 초안. additive·null default — 구 소비자 호환.
    drafted_by_member_id: uuid.UUID | None = None
    draft_metadata: dict[str, Any] | None = None
    human_accounting: dict[str, Any]
    gate_contract: dict[str, Any]
    epic_ids: list[uuid.UUID] = []
    story_ids: list[uuid.UUID] = []
    # N:1(PO 결) — sprint 링크는 최대 1개라 리스트가 아니라 nullable 단일 값.
    sprint_id: uuid.UUID | None = None
    # story #2533(E-FLOW-V4 S3, migration 0237): 정반합 self-FK — 이 가설이 falsified된 뒤
    # 대체된 새 가설. write path(자동 페어링·전이 UI)는 후속 스토리 — 지금은 확認된 단일
    # 페어만 채워지고 나머지는 null("아직", 없는 데이터 지어내기 X).
    superseded_by_hypothesis_id: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime

    # story #2262(C-4) AC9: 참조 카드의 「다음 행동」 재료 — SSOT는 app.services.next_action.
    @computed_field  # type: ignore[prop-decorator]
    @property
    def next_action_code(self) -> str | None:
        from app.services.next_action import hypothesis_next_action
        return hypothesis_next_action(
            status=self.status, measure_after=self.measure_after, metric_definition=self.metric_definition,
        )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def next_action_category(self) -> str | None:
        from app.services.next_action import next_action_category
        return next_action_category(self.next_action_code)

    @classmethod
    def from_model(
        cls,
        obj: Any,
        epic_ids: list[uuid.UUID] | None = None,
        story_ids: list[uuid.UUID] | None = None,
        sprint_id: uuid.UUID | None = None,
    ) -> "HypothesisResponse":
        # epic_ids/story_ids/sprint_id는 모델 컬럼이 아니라 링크 테이블 집계 — 서비스가 주입한다.
        resp = cls.model_validate(obj)
        resp.epic_ids = epic_ids or []
        resp.story_ids = story_ids or []
        resp.sprint_id = sprint_id
        return resp


class HypothesisDraftRequest(BaseModel):
    """§3.9 — 흐름 부산물에서 AI 초안 생성. persist=true이면 status='proposed' row만 생성.

    S16 BE 갭(유나 적출, 2026-07-02): "loop_goal"은 유저가 loop-create 폼에 방금 타이핑한
    goal 텍스트에서 초안 — 백킹 엔티티가 없어 source_id가 없다(context dict만으로 draft).
    기존 4종(epic/story/conversation/dispatch)은 source_id 필수 그대로(회귀 방지)."""
    project_id: uuid.UUID
    source_type: str  # "epic" | "story" | "conversation" | "dispatch" | "loop_goal"
    source_id: uuid.UUID | None = None
    context: dict[str, Any] | None = None
    persist: bool = False

    @model_validator(mode="after")
    def _source_id_required_unless_loop_goal(self) -> "HypothesisDraftRequest":
        if self.source_type != "loop_goal" and self.source_id is None:
            raise ValueError("source_id는 loop_goal 외 source_type에서 필수입니다.")
        return self


class HypothesisDraftResponse(BaseModel):
    statement: str
    metric_definition: dict[str, Any]
    measure_after: datetime
    source_snapshot: dict[str, Any]
    confidence: float | None = None
    requires_confirmation: bool = True
    # persist=true일 때만 — 생성된 proposed row.
    hypothesis: HypothesisResponse | None = None


# story #2533(E-FLOW-V4 S3): GET /{id}/lifecycle 조립 응답 — 5축 수직 서사.
# 지어내지 않는다 원칙: 없는 축(증명 미도달·정반합 미확認·진짜 전이 이력)은 항상 None/빈
# 값으로 정직하게 비운다(유·미르코 시안 f60d0502 "빈 칸=아직" 규격과 정합).


class HypothesisLifecycleGoal(BaseModel):
    """목표(에픽) — hypothesis_epic_links 확장(id만이 아니라 이름·상태까지)."""
    id: uuid.UUID
    title: str
    status: str


class HypothesisLifecycleStory(BaseModel):
    """검증(스토리) — hypothesis_story_links 확장 + 증명(gate/evidence) 간접 조회.

    gate_status/evidence_count: work_item_type='story'로 hypothesis_story_links를 거쳐
    간접 조회한다(hypothesis에 직접 달리는 gate/evidence는 실사용 0 — 그라운딩 확認,
    2026-08-09). 매칭 row가 없으면 gate_status=None("아직")·evidence_count=0으로 정직."""
    id: uuid.UUID
    title: str
    status: str
    metric_definition: dict[str, Any] | None = None
    outcome_status: str
    gate_status: str | None = None
    evidence_count: int = 0


class HypothesisLifecycleSuccessor(BaseModel):
    """정반합 링크 한쪽(계승자 또는 전신) — superseded_by_hypothesis_id 확장."""
    id: uuid.UUID
    statement: str
    status: str


class HypothesisLifecycleTimeline(BaseModel):
    """시간선 — ⛔진짜 전이 이력이 아니다(hypothesis_status_events류 감사 테이블 없음,
    activity_log에도 hypothesis 참조 0건 — 그라운딩 확認). 딱 3점(created/measure_after/
    updated)만 정직하게 반환한다. FE가 이걸 "전체 생애 타임라인"으로 과대포장하면 안 된다
    (이 docstring이 그 경계선)."""
    created_at: datetime
    measure_after: datetime
    updated_at: datetime


class HypothesisLifecycleResponse(BaseModel):
    hypothesis: HypothesisResponse
    goals: list[HypothesisLifecycleGoal] = []
    stories: list[HypothesisLifecycleStory] = []
    # 정반합 양방향 — 이 가설을 대체한 것(계승자) + 이 가설이 대체한 것들(전신, 역방향 FK).
    # 확認된 페어(migration 0237) 외엔 항상 None/빈 리스트("아직" — 자동 페어링 없음).
    superseded_by: HypothesisLifecycleSuccessor | None = None
    supersedes: list[HypothesisLifecycleSuccessor] = []
    timeline: HypothesisLifecycleTimeline
