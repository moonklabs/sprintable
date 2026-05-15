"""EE: Activity Log RBAC 가시성 필터 (S-C4).

CE fallback: activity_logs.py에서 조건부 import — ee/ 없으면 이 파일 로드 안 됨.
"""
from __future__ import annotations

import uuid
import logging

from sqlalchemy import select
from sqlalchemy.sql import Select

logger = logging.getLogger(__name__)

_VALID_ROLES = {"owner", "admin", "member"}


def filter_activity_by_role(
    query: Select,
    member_role: str,
    member_id: uuid.UUID,
) -> Select:
    """role별 가시성 필터 적용.

    - owner: 전체 (필터 없음)
    - admin: actor_type='agent' 만
    - member: 본인(member_id)의 actor_id 만 (본인 agent 행위만)
    """
    from app.models.activity_log import ActivityLog

    if member_role == "owner":
        return query

    if member_role == "admin":
        return query.where(ActivityLog.actor_type == "agent")

    # member 이하: 본인 actor_id만
    return query.where(ActivityLog.actor_id == member_id)
