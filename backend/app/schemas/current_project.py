from __future__ import annotations

import uuid

from pydantic import BaseModel


class CurrentProjectResponse(BaseModel):
    project_id: uuid.UUID | None
    project_name: str | None
    org_id: uuid.UUID | None


class SetCurrentProject(BaseModel):
    project_id: uuid.UUID
