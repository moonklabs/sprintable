from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class UsageMeterOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    meter_type: str
    current_value: int
    limit_value: int | None = None
    period_start: datetime
    # story #3175 — DB가 NOT NULL(디폴트 없음)로 정본 확定, ORM도 정렬 완료. 실제로 None인
    # 행은 존재할 수 없다(CHECK가 아니라 컬럼 자체 제약).
    period_end: datetime
