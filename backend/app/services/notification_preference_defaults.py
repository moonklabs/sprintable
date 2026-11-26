"""member 생성 시 기본 NotificationPreference 자동 삽입 헬퍼."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.notification_preference import NotificationPreference

_HUMAN_DEFAULTS = [("global", "in_app", "all")]
# story 5030: 에이전트는 가입 때 설정 행을 심지 않는다 — «행 없음 = 제품 기본»(일대일은 all · 그룹은 부른 말만).
# 예전엔 global/sse/all을 명시로 심어, 사용자가 고른 적 없는 값이 그룹 기본(mentions)보다 앞서 에이전트가
# 모든 말을 받았다(channel_router는 명시 행을 기본보다 앞세운다). 에이전트별 «이 채널 모든 말 받기»는
# 대화·프로젝트 범위 all 행(PUT /notification-preferences)이 그대로 기본보다 앞선다.
_AGENT_DEFAULTS: list[tuple[str, str, str]] = []


async def insert_default_preferences(
    db: AsyncSession,
    member_id: uuid.UUID,
    member_type: str,
) -> None:
    """human → global/in_app/all 기본 preference 삽입. agent → 삽입 없음(위 _AGENT_DEFAULTS)."""
    defaults = _HUMAN_DEFAULTS if member_type == "human" else _AGENT_DEFAULTS
    now = datetime.now(timezone.utc)
    for scope_type, channel, level in defaults:
        db.add(NotificationPreference(
            id=uuid.uuid4(),
            member_id=member_id,
            scope_type=scope_type,
            scope_id=None,
            channel=channel,
            level=level,
            created_at=now,
            updated_at=now,
        ))
