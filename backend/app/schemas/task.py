import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, computed_field, field_validator


class TaskCreate(BaseModel):
    story_id: uuid.UUID
    org_id: uuid.UUID
    title: str
    assignee_id: uuid.UUID | None = None
    status: str = "todo"
    story_points: int | None = None


class TaskUpdate(BaseModel):
    title: str | None = None
    status: str | None = None
    assignee_id: uuid.UUID | None = None
    story_points: int | None = None


class TaskResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    story_id: uuid.UUID
    org_id: uuid.UUID
    assignee_id: uuid.UUID | None = None
    title: str
    status: str
    story_points: int | None = None
    created_at: datetime
    updated_at: datetime

    # story #2642(웹·칩 공통, 2026-08-14) — Task 모델 자체엔 project_id 컬럼이 없다(story_id
    # 경유로만 알 수 있다, 미르코 실측). #2168 DocPreviewResponse와 동형으로 project_id+
    # org_slug/project_slug를 additive로 싣는다 — 셋 다 ORM 컬럼 아님, 라우터가
    # Task.story_id → Story.project_id 1-hop join 후 model_validate 前 transient attr로 세팅
    # (has_evidence 패턴 동형).
    project_id: uuid.UUID | None = None
    org_slug: str | None = None
    project_slug: str | None = None

    @field_validator("project_id", mode="before")
    @classmethod
    def _coerce_project_id(cls, v):
        return v if isinstance(v, uuid.UUID) else None

    @field_validator("org_slug", "project_slug", mode="before")
    @classmethod
    def _coerce_slug_fields(cls, v):
        return v if isinstance(v, str) else None

    # E-VERIFY V0-S2(story 3fbd048d): evidence-backed 신호(positive 단방향) — story.has_evidence와
    # 동형(True 또는 None, False 없음). 라우터가 model_validate 前 transient attr로 세팅.
    has_evidence: bool | None = None

    @field_validator("has_evidence", mode="before")
    @classmethod
    def _coerce_has_evidence(cls, v):
        return v if isinstance(v, bool) else None

    # Claimed vs Verified(doc claimed-vs-verified-spec-handoff §3) — story.py와 동형.
    self_reported: bool | None = None
    human_verified: bool | None = None
    human_verified_by: uuid.UUID | None = None
    human_verified_at: datetime | None = None

    @field_validator("self_reported", "human_verified", mode="before")
    @classmethod
    def _coerce_evidence_bool_signal(cls, v):
        return v if isinstance(v, bool) else None

    @field_validator("human_verified_by", mode="before")
    @classmethod
    def _coerce_human_verified_by(cls, v):
        return v if isinstance(v, uuid.UUID) else None

    @field_validator("human_verified_at", mode="before")
    @classmethod
    def _coerce_human_verified_at(cls, v):
        return v if isinstance(v, datetime) else None

    # story #2262(C-4) AC9: 참조 카드의 「다음 행동」 재료 — SSOT는 app.services.next_action.
    @computed_field  # type: ignore[prop-decorator]
    @property
    def next_action_code(self) -> str | None:
        from app.services.next_action import verification_next_action
        return verification_next_action(self_reported=self.self_reported, human_verified=self.human_verified)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def next_action_category(self) -> str | None:
        from app.services.next_action import next_action_category
        return next_action_category(self.next_action_code)
