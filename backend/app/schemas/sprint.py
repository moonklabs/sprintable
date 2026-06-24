import uuid
from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, field_validator, model_validator
from app.schemas.story import _validate_metric_definition

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

    @model_validator(mode="after")
    def _derive_duration_from_dates(self) -> "SprintResponse":
        """8a2bbda2: 날짜가 있으면 duration 을 날짜에서 파생(stored 14 오염 무시).

        기존 스프린트(stored=14)도 API 응답이 날짜 기준 정합값을 반환 → 백필 불요.
        """
        derived = compute_sprint_duration(self.start_date, self.end_date, self.duration)
        if derived is not None:
            self.duration = derived
        return self


class KickoffBody(BaseModel):
    message: str | None = None
