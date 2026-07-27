import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class ProjectCreate(BaseModel):
    org_id: uuid.UUID
    name: str
    description: str | None = None
    # story 139d2405(S-slug-infra): 미지정 시 서버가 name→kebab 파생(org 내 유일 자동 해소).
    # 지정 시 형식/유일성 검증(라우터에서 — DB 조회 필요라 pydantic validator 밖).
    slug: str | None = None


class ProjectUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    slug: str | None = None


class ProjectResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    name: str
    # story 139d2405(S-slug-infra): 모델과 동형 nullable — raw seed(테스트 등)로 만들어진 legacy
    # project는 slug가 없을 수 있음(app/models/project.py 주석 참고). API로 생성된 project는 항상 값 有.
    slug: str | None = None
    description: str | None = None
    created_at: datetime
    updated_at: datetime
