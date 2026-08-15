import uuid
from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, computed_field, field_validator, model_validator
from app.schemas.story import _validate_metric_definition
from app.schemas.validators import is_blank

# story #2413 AC3(PO 지시, 2026-08-02) — 제목이 빈 스프린트를 만들 수 없게 서버가 거부한다.
# ⭐관측된 결함 수정이 아니라 방어다 — 실측(dev, MCP list_sprints): 16건 중 blank title 0건.
# 지금 고장난 것을 고친 게 아니라, 아직 빈 구멍을 미리 막은 것(#2413 retro.py 쪽 동형 주석 참고).
_BLANK_TITLE_MSG = "title은 비어 있을 수 없습니다"

# E-DG S26: sprint status contract. de-facto(planning|active|done)에 review(선택)·archived(terminal) 신설.
# ⭐review 선택(active→done 직행 허용·active→review→done도 OK). hypothesis/epic _VALID_TRANSITIONS 패턴.
SPRINT_STATUSES = ("planning", "active", "review", "closed", "archived")
_SPRINT_VALID_TRANSITIONS: set[tuple[str, str]] = {
    ("planning", "active"),     # 시작(activate·1-active 제약·overlay-gated)
    ("planning", "closed"),     # 시작 전 폐기(cancel/discard·한번도 안 뛴 스프린트·velocity 0·non-gated)
    ("active", "review"),        # review 단계(선택)
    ("active", "closed"),        # 마감 직행(review 생략·overlay-gated). close-state=closed(de-facto·decision① B)
    ("review", "closed"),        # 마감(review 경유·overlay-gated)
    ("closed", "archived"),      # 보관(native)
}


def is_valid_sprint_transition(from_status: str, to_status: str) -> bool:
    return (from_status, to_status) in _SPRINT_VALID_TRANSITIONS


def compute_sprint_duration(
    start_date: date | None,
    end_date: date | None,
    fallback: int | None = None,
) -> int | None:
    """8a2bbda2: 스프린트 기간(일)은 start_date/end_date 가 단일진실.

    `(end_date - start_date).days + 1`(inclusive — 6/1~6/5 = 5d·기본 14d = 6/1~6/14 와 정합).
    양 날짜가 모두 있고 end >= start 일 때만 산출, 아니면 fallback(stored duration). stored
    `duration` 컬럼은 날짜와 무관(default 14)하게 오염될 수 있어 display/analytics 는 이 계산을 쓴다.
    """
    if start_date is not None and end_date is not None and end_date >= start_date:
        return (end_date - start_date).days + 1
    return fallback


class SprintBase(BaseModel):
    title: str
    start_date: date | None = None
    end_date: date | None = None
    team_size: int | None = None
    # E-BOARD-SCHEMA S4: 실행 목표(goal)·가용 공수(capacity)
    goal: str | None = None
    capacity: int | None = None
    # E-OUTCOME-LOOP: 효과 가설(success_hypothesis) — goal(실행 목표)과 별개
    success_hypothesis: str | None = None
    metric_definition: dict[str, Any] | None = None
    measure_after: datetime | None = None

    @field_validator("metric_definition")
    @classmethod
    def validate_metric_definition(cls, v: dict | None) -> dict | None:
        return _validate_metric_definition(v)

    @field_validator("title")
    @classmethod
    def _reject_blank_title(cls, v: str) -> str:
        if is_blank(v):
            raise ValueError(_BLANK_TITLE_MSG)
        return v


class SprintCreate(SprintBase):
    project_id: uuid.UUID
    org_id: uuid.UUID


class SprintUpdate(BaseModel):
    title: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    team_size: int | None = None
    status: str | None = None
    velocity: int | None = None
    duration: int | None = None
    report_doc_id: uuid.UUID | None = None
    # E-BOARD-SCHEMA S4
    goal: str | None = None
    capacity: int | None = None
    # E-OUTCOME-LOOP: 의도 필드 (Update 허용)
    success_hypothesis: str | None = None
    metric_definition: dict[str, Any] | None = None
    measure_after: datetime | None = None
    # outcome_status/outcome_result는 Update 제외 — 채점잡 전용

    @field_validator("metric_definition")
    @classmethod
    def validate_metric_definition(cls, v: dict | None) -> dict | None:
        return _validate_metric_definition(v)

    @field_validator("title")
    @classmethod
    def _reject_blank_title(cls, v: str | None) -> str | None:
        # None(생략 또는 명시 null)은 통과 — update_sprint가 model_dump(exclude_unset=True)라
        # 생략 필드는 애초에 안 건드린다. 명시적으로 ""를 보낸 경우만 거부(story #2413 AC3).
        if v is not None and is_blank(v):
            raise ValueError(_BLANK_TITLE_MSG)
        return v


class SprintResponse(SprintBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    org_id: uuid.UUID
    status: str
    velocity: int | None = None
    duration: int
    report_doc_id: uuid.UUID | None = None
    # E-OUTCOME-LOOP: 채점 필드
    outcome_status: str = "n_a"
    outcome_result: dict[str, Any] | None = None
    created_at: datetime
    updated_at: datetime

    # story #2642(웹·칩 공통, 2026-08-14) — #2168 DocPreviewResponse와 동형. project_id는
    # 이미 있어 additive slug 2개만. 새 preview 라우트 대신 이 응답을 제자리 확장(PO 판정 —
    # GET /{id}가 이미 project_id-스코프 단건조회라 preview와 비용/모양이 같다). ORM 컬럼
    # 아님 — 라우터가 model_validate 前 transient attr로 세팅.
    org_slug: str | None = None
    project_slug: str | None = None

    @field_validator("org_slug", "project_slug", mode="before")
    @classmethod
    def _coerce_slug_fields(cls, v):
        return v if isinstance(v, str) else None

    @model_validator(mode="after")
    def _derive_duration_from_dates(self) -> "SprintResponse":
        """8a2bbda2: 날짜가 있으면 duration 을 날짜에서 파생(stored 14 오염 무시).

        기존 스프린트(stored=14)도 API 응답이 날짜 기준 정합값을 반환 → 백필 불요.
        """
        derived = compute_sprint_duration(self.start_date, self.end_date, self.duration)
        if derived is not None:
            self.duration = derived
        return self

    # story #2262(C-4) AC9: outcome-measurement 축만(doc `e-connect-c4-trigger-condition-
    # table` 승인 범위) — internal_ops는 sprint close() 시점 즉시 채점(repositories/
    # sprint.py) — cron 지연 아님. 그래도 「사람 몫이 아니다」는 동일하므로 system_owned_
    # sources에 그대로 포함한다(④주체 판정은 "언제"가 아니라 "누구"라 이 축에선 영향 없음).
    # ⛔「기간 지났는데 안 닫힘」 축은 별건(doc에 기록, 미구현).
    @computed_field  # type: ignore[prop-decorator]
    @property
    def next_action_code(self) -> str | None:
        from app.services.next_action import outcome_measurement_next_action
        return outcome_measurement_next_action(
            outcome_status=self.outcome_status, measure_after=self.measure_after,
            metric_definition=self.metric_definition, system_owned_sources=frozenset({"ga4", "internal_ops"}),
        )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def next_action_category(self) -> str | None:
        from app.services.next_action import next_action_category
        return next_action_category(self.next_action_code)


class KickoffBody(BaseModel):
    message: str | None = None
