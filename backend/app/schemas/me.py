from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class MeResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    user_id: uuid.UUID | None = None
    name: str
    email: str | None = None  # E-ONBOARDING S2: User.email 노출
    type: str
    role: str
    is_active: bool
    project_name: str | None = None
    has_password: bool | None = None
    # story #3122(계정 연결) — 설정 화면이 "어떤 provider가 이미 연결돼 있는지" 그리는 데 씀.
    # linked_providers=[]가 has_password=False와 같이 오면(둘 다 로그인 수단 0) 그 자체가
    # 이상 상태(가입 rail 어딘가 결함)라 unlink 가드(auth.py LAST_LOGIN_METHOD)가 막는다 —
    # 이 응답 필드는 순수 표시용, unlink 허용 판정은 서버가 매번 다시 계산한다(신뢰 안 함).
    linked_providers: list[str] = []


class UpdateMe(BaseModel):
    name: str
