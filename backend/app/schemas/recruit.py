"""E-RECRUIT S3 (story ff2996d0): POST /recruit 요청 스키마."""
from __future__ import annotations

from pydantic import BaseModel

from app.services.agent_onboarding_config import DEFAULT_RUNTIME


class RecruitRequest(BaseModel):
    role_template_slug: str
    runtime: str = DEFAULT_RUNTIME
    # E-I18N Phase C(story 11f1087c): FE가 자기 next-intl locale을 명시 전달(정확) — 없으면
    # 라우터가 Accept-Language 헤더로 폴백(resolve_locale_from_request). DB 영속 저장 없음.
    locale: str | None = None
