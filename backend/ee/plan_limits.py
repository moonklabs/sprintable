"""EE Plan Limit 정책 (E-ORG-MULTI S5.5).

Free 플랜 제한:
  - Org: 사용자당 1개 (owner 기준)
  - Project: org당 1개
  - Member: org당 5명

Team/Pro: 제한 없음.
"""
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

FREE_LIMITS: dict[str, int] = {
    "max_orgs_owned": 1,
    "max_projects": 1,
    "max_members": 5,
}

# API 초과 과금 정책 (per call, USD)
API_OVERAGE_RATES: dict[str, float] = {
    "team": 0.001,
    "pro": 0.0005,
}


def _plan_limit_error(resource: str, limit: int) -> HTTPException:
    return HTTPException(
        status_code=402,
        detail={
            "code": "PLAN_LIMIT_EXCEEDED",
            "resource": resource,
            "limit": limit,
            "tier": "free",
            "upgrade_required": True,
            "message": f"Free plan {resource} limit ({limit}) reached. Upgrade to Team or Pro.",
        },
    )


async def _get_org_tier(session: AsyncSession, org_id) -> str:
    """org_subscriptions에서 tier 조회. 레코드 없으면 free."""
    result = await session.execute(
        text("SELECT tier FROM org_subscriptions WHERE org_id = :oid"),
        {"oid": str(org_id)},
    )
    row = result.first()
    return (row[0] if row else None) or "free"


async def check_org_create_limit(session: AsyncSession, user_id) -> None:
    """Free: 사용자당 owner org 1개 제한."""
    result = await session.execute(
        text(
            "SELECT COUNT(*) FROM org_members"
            " WHERE user_id = :uid AND role = 'owner' AND deleted_at IS NULL"
        ),
        {"uid": str(user_id)},
    )
    count = result.scalar() or 0
    if count >= FREE_LIMITS["max_orgs_owned"]:
        raise _plan_limit_error("org", FREE_LIMITS["max_orgs_owned"])


async def check_project_create_limit(session: AsyncSession, org_id) -> None:
    """Free: org당 project 1개 제한. Team/Pro는 스킵."""
    tier = await _get_org_tier(session, org_id)
    if tier != "free":
        return
    result = await session.execute(
        text("SELECT COUNT(*) FROM projects WHERE org_id = :oid AND deleted_at IS NULL"),
        {"oid": str(org_id)},
    )
    count = result.scalar() or 0
    if count >= FREE_LIMITS["max_projects"]:
        raise _plan_limit_error("project", FREE_LIMITS["max_projects"])


async def check_member_invite_limit(session: AsyncSession, org_id) -> None:
    """Free: org당 member 5명 제한 (human + agent). Team/Pro는 스킵."""
    tier = await _get_org_tier(session, org_id)
    if tier != "free":
        return
    result = await session.execute(
        text(
            "SELECT COUNT(*) FROM org_members"
            " WHERE org_id = :oid AND deleted_at IS NULL"
        ),
        {"oid": str(org_id)},
    )
    count = result.scalar() or 0
    if count >= FREE_LIMITS["max_members"]:
        raise _plan_limit_error("member", FREE_LIMITS["max_members"])
