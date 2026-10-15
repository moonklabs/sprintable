import re
import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, field_validator
from app.schemas.not_null_fields import RejectsExplicitNull

# [SID:4681] (UX-1 · D3 · AC4): `workdir_hint` is a line of text a person typed or picked on their own computer — shown back to
# people and other devices as a hint, never opened as a path by the server. The only checks are text checks: trimmed, empty →
# none, a length cap, no control characters (a terminal-escape or NUL in a hint must not reach a screen or a log).
WORKDIR_HINT_MAX_LEN = 1024
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def normalize_workdir_hint(value: str | None) -> str | None:
    """Trimmed text or None (empty → None). Raises ValueError for too long or control characters — a 422 at the schema."""
    if value is None:
        return None
    text = value.strip()
    if text == "":
        return None
    if len(text) > WORKDIR_HINT_MAX_LEN:
        raise ValueError(f"workdir_hint is too long (max {WORKDIR_HINT_MAX_LEN} characters)")
    if _CONTROL_CHARS.search(text):
        raise ValueError("workdir_hint must not contain control characters")
    return text


class ProjectCreate(BaseModel):
    org_id: uuid.UUID
    name: str
    description: str | None = None
    # story 139d2405(S-slug-infra): 미지정 시 서버가 name→kebab 파생(org 내 유일 자동 해소).
    # 지정 시 형식/유일성 검증(라우터에서 — DB 조회 필요라 pydantic validator 밖).
    slug: str | None = None
    # [SID:4681]: the project's folder on the person's computer, as text (see normalize_workdir_hint) — optional
    workdir_hint: str | None = None

    @field_validator("workdir_hint")
    @classmethod
    def _workdir_hint(cls, value: str | None) -> str | None:
        return normalize_workdir_hint(value)


class ProjectUpdate(RejectsExplicitNull):
    # story #4337 — DB 칸이 NOT NULL인 필드: 생략 = 그대로 · 명시 null은 422(예전엔 저장에서 무결성 오류 500).
    NOT_NULL_FIELDS = frozenset({"name"})

    name: str | None = None
    description: str | None = None
    slug: str | None = None
    # [SID:4681]: omitted = unchanged · null = cleared (the column is nullable) · text = the same checks as on create
    workdir_hint: str | None = None

    @field_validator("workdir_hint")
    @classmethod
    def _workdir_hint(cls, value: str | None) -> str | None:
        return normalize_workdir_hint(value)


class ProjectResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    name: str
    # story 139d2405(S-slug-infra): 모델과 동형 nullable — raw seed(테스트 등)로 만들어진 legacy
    # project는 slug가 없을 수 있음(app/models/project.py 주석 참고). API로 생성된 project는 항상 값 有.
    slug: str | None = None
    description: str | None = None
    # [SID:4681]: shown as text — the web draws it beside the project; the Mac keeps its own folder mapping
    workdir_hint: str | None = None
    created_at: datetime
    updated_at: datetime
