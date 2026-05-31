"""E-CAGE-REFEREE P3: gate disposition 해소 서비스.

precedence (높음→낮음):
  1. member_gate_override  — 개별 예외 (최우선)
  2. org_gate_override     — role × gate_type 오버라이드
  3. org_gate_policy       — org posture 기본값
  4. 시스템 기본값          — "ask"

risk_level 입력 없음 — 플랫폼은 위험도 판정 안 함.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hitl_config import (
    SYSTEM_DEFAULT_DISPOSITION,
    MemberGateOverride,
    OrgGateOverride,
    OrgGatePolicy,
    posture_to_disposition,
)


async def resolve_disposition(
    session: AsyncSession,
    org_id: uuid.UUID,
    member_id: uuid.UUID,
    role_id: uuid.UUID,
    gate_type: str,
) -> str:
    """(org, member, role, gate_type) → disposition 해소.

    Returns:
        'allow_auto' | 'ask' | 'deny'
    """
    # 1. member_gate_override (최우선)
    mo_r = await session.execute(
        select(MemberGateOverride).where(
            MemberGateOverride.org_id == org_id,
            MemberGateOverride.member_id == member_id,
            MemberGateOverride.gate_type == gate_type,
        ).limit(1)
    )
    mo = mo_r.scalar_one_or_none()
    if mo is not None:
        return mo.disposition

    # 2. org_gate_override (role × gate_type)
    ro_r = await session.execute(
        select(OrgGateOverride).where(
            OrgGateOverride.org_id == org_id,
            OrgGateOverride.role_id == role_id,
            OrgGateOverride.gate_type == gate_type,
        ).limit(1)
    )
    ro = ro_r.scalar_one_or_none()
    if ro is not None:
        return ro.disposition

    # 3. org posture 기본값
    policy_r = await session.execute(
        select(OrgGatePolicy).where(OrgGatePolicy.org_id == org_id).limit(1)
    )
    policy = policy_r.scalar_one_or_none()
    if policy is not None:
        return posture_to_disposition(policy.posture)

    # 4. 시스템 기본값
    return SYSTEM_DEFAULT_DISPOSITION
