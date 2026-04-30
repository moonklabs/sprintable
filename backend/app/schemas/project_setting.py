from __future__ import annotations

import uuid
from datetime import datetime, time

from pydantic import BaseModel, ConfigDict


class ProjectSettingResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    project_id: uuid.UUID
    standup_deadline: time
    created_at: datetime
    updated_at: datetime


class UpdateProjectSetting(BaseModel):
    project_id: uuid.UUID
    standup_deadline: str = "09:00"
