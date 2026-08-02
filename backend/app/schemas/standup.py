import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, model_validator

from app.schemas.validators import reject_if_all_blank

REVIEW_TYPES = ("comment", "approve", "request_changes")


class StandupUpsert(BaseModel):
    # 1c2be9db: org-level write — project_id 생략 가능. 생략 시 entry 링크 = author 접근
    # 프로젝트 자동(accessible_project_ids_in_org). 명시 시 그 프로젝트 additive 링크(legacy).
    project_id: uuid.UUID | None = None
    org_id: uuid.UUID | None = None
    author_id: uuid.UUID
    date: date
    sprint_id: uuid.UUID | None = None
    done: str | None = None
    plan: str | None = None
    blockers: str | None = None
    plan_story_ids: list[uuid.UUID] = []

    # story #2414(PO 지시, 2026-08-02) — 세 칸이 전부 빈 스탠드업이 저장돼 있었다(실측
    # 2건). done만 빈 것(오늘 시작한 사람)은 정상이라 막지 않는다 — 실측 122건 중 73건이
    # 이 모양이라 그것까지 막으면 과잉차단이다. 셋 다 빌 때만 거부.
    @model_validator(mode="after")
    def _reject_all_blank_content(self) -> "StandupUpsert":
        reject_if_all_blank(done=self.done, plan=self.plan, blockers=self.blockers)
        return self


class StandupSelfUpdate(BaseModel):
    """self-save(PUT) 전용 — author_id는 서버가 인증 유저(resolve_member)에서 도출.

    클라 바디 author_id를 받지 않아 타인 스탠드업 위조를 차단(SID:6a1e8b1d).
    project_id는 바디 수용(생략 가능 — 1c2be9db org-level). (extra 필드는 pydantic 기본 무시)
    """
    project_id: uuid.UUID | None = None
    date: date
    sprint_id: uuid.UUID | None = None
    done: str | None = None
    plan: str | None = None
    blockers: str | None = None
    plan_story_ids: list[uuid.UUID] = []

    # story #2414 — POST(StandupUpsert)와 동일 규칙, PUT도 같은 결함을 낼 수 있어 동형 적용.
    @model_validator(mode="after")
    def _reject_all_blank_content(self) -> "StandupSelfUpdate":
        reject_if_all_blank(done=self.done, plan=self.plan, blockers=self.blockers)
        return self


class StandupEntryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID | None = None  # 1c2be9db: org-level 엔트리는 origin project_id 가 NULL 일 수 있음
    org_id: uuid.UUID
    sprint_id: uuid.UUID | None = None
    author_id: uuid.UUID
    date: date
    done: str | None = None
    plan: str | None = None
    blockers: str | None = None
    plan_story_ids: list[uuid.UUID]
    # a9e67531: plan_story_ids 의 org-scope resolve 요약(id+title+status). FE 가 active-sprint stories 배열에
    # 의존하지 않고 cross-board plan story 도 렌더(미노출 버그 근본 fix). plan_story_ids 는 하위호환 유지.
    plan_stories: list["PlanStorySummary"] = []
    created_at: datetime
    updated_at: datetime


class PlanStorySummary(BaseModel):
    id: uuid.UUID
    title: str
    status: str
    priority: str | None = None
    project_id: uuid.UUID | None = None
    sprint_id: uuid.UUID | None = None


class FeedbackCreate(BaseModel):
    org_id: uuid.UUID
    project_id: uuid.UUID
    sprint_id: uuid.UUID | None = None
    feedback_by_id: uuid.UUID
    review_type: str = "comment"
    feedback_text: str


class FeedbackResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    org_id: uuid.UUID
    sprint_id: uuid.UUID | None = None
    standup_entry_id: uuid.UUID
    feedback_by_id: uuid.UUID
    review_type: str
    feedback_text: str
    created_at: datetime
    updated_at: datetime
