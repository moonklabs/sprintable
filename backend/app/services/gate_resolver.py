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


# SID 301ee45d/#2047 AC1: resolve_disposition 반환값의 두 번째 요소 — 어느 precedence 단계에서
# disposition이 나왔는지(명시 설정 vs 시스템 기본). "system_default"만 비명시(암묵) — 나머지 셋은
# 조직/멤버가 어떤 형태로든 명시한 값이라 explicit로 취급한다(호출부의 `source != "system_default"`
# 판정 기준).
SOURCE_MEMBER_OVERRIDE = "member_override"
SOURCE_ORG_OVERRIDE = "org_override"
SOURCE_ORG_POLICY = "org_policy"
SOURCE_SYSTEM_DEFAULT = "system_default"


async def resolve_disposition(
    session: AsyncSession,
    org_id: uuid.UUID,
    member_id: uuid.UUID,
    role_id: uuid.UUID,
    gate_type: str,
) -> tuple[str, str]:
    """(org, member, role, gate_type) → (disposition, source) 해소.

    SID 301ee45d/#2047 AC1: 이전엔 disposition 문자열만 돌려줘 호출부가 "조직이 명시
    설정했다"와 "아무도 설정 안 해서 시스템 기본이 나왔다"를 구분할 수 없었다 — 그래서 증거
    없는 merge 게이트 경로가 명시 ask 정책까지 시스템 기본 ask와 똑같이 취급해 우회했다
    (merge_verdict_gate.py의 no-substance 체크). source를 노출해 그 구분을 가능하게 한다.

    Returns:
        (disposition, source) — disposition: 'allow_auto' | 'ask' | 'deny'.
        source: SOURCE_MEMBER_OVERRIDE | SOURCE_ORG_OVERRIDE | SOURCE_ORG_POLICY | SOURCE_SYSTEM_DEFAULT.
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
        return mo.disposition, SOURCE_MEMBER_OVERRIDE

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
        return ro.disposition, SOURCE_ORG_OVERRIDE

    # 3. org posture 기본값
    policy_r = await session.execute(
        select(OrgGatePolicy).where(OrgGatePolicy.org_id == org_id).limit(1)
    )
    policy = policy_r.scalar_one_or_none()
    if policy is not None:
        return posture_to_disposition(policy.posture), SOURCE_ORG_POLICY

    # 4. 시스템 기본값
    return SYSTEM_DEFAULT_DISPOSITION, SOURCE_SYSTEM_DEFAULT
