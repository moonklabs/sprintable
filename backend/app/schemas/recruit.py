"""E-RECRUIT S3 (story ff2996d0): POST /recruit 요청 스키마."""
from __future__ import annotations

from pydantic import BaseModel

from app.services.agent_onboarding_config import DEFAULT_RUNTIME


class RecruitRequest(BaseModel):
    role_template_slug: str
    runtime: str = DEFAULT_RUNTIME
