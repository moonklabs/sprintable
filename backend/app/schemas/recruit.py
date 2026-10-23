"""E-RECRUIT S3 (story ff2996d0): POST /recruit 요청 스키마."""
from __future__ import annotations

from pydantic import BaseModel, StrictBool

from app.services.agent_onboarding_config import DEFAULT_RUNTIME


class RecruitRequest(BaseModel):
    role_template_slug: str
    runtime: str = DEFAULT_RUNTIME
    # E-I18N Phase C(story 11f1087c): FE가 자기 next-intl locale을 명시 전달(정확) — 없으면
    # 라우터가 Accept-Language 헤더로 폴백(resolve_locale_from_request). DB 영속 저장 없음.
    locale: str | None = None
    # story 4710 (Kadir · PO 06:11Z): False → the hire issues NO key at all — the answer carries `api_key: null` and no key row is made or rotated
    # (an active key the agent already has is only ever NARROWED to what it may do today ∩ the role's scope — never widened). For the in-app hire, whose
    # next step is the setup's move: that exchange makes the agent's key, so a key handed to the browser here would be one nobody uses and
    # that nothing revokes if the person closes the tab. Default True = the answer as before.
    issue_key: StrictBool = True  # strict: «false» / 0 are 422, not a quiet False (or True)
