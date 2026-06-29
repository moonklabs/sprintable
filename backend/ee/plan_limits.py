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


def _storage_limit_error(resource: str, limit_mb: int, tier: str) -> HTTPException:
    upgrade = tier != "pro"
    msg = (
        f"{tier} plan {resource} limit ({limit_mb}MB) reached. Upgrade for more capacity."
        if upgrade else f"{resource} limit ({limit_mb}MB) reached."
    )
    return HTTPException(
        status_code=402,
        detail={
            "code": "PLAN_LIMIT_EXCEEDED",
            "resource": resource,
            "limit_mb": limit_mb,
            "tier": tier,
            "upgrade_required": upgrade,
            "message": msg,
        },
    )


async def get_org_storage_limit_bytes(session: AsyncSession, org_id) -> int | None:
    """org tier 의 storage 캡(bytes). 캡 미정의 tier=None(무제한). storage-usage 표시 공용(server 권위 SSOT)."""
    tier = await _get_org_tier(session, org_id)
    row = (await session.execute(
        text("SELECT max_storage_mb FROM plan_tier_limits WHERE tier = :t"), {"t": tier},
    )).first()
    return int(row[0]) * 1024 * 1024 if row else None


async def check_storage_capacity(session: AsyncSession, org_id, attachments: list[dict] | None) -> None:
    """S8: org storage 캡 enforce(서버 게이트·all tiers). per-file + 총량(committed+신규).

    tier(org_subscriptions)→plan_tier_limits[tier]→캡. 캡 미정의 tier=무제한(no-op). **우리 버킷 객체만**
    카운트(canonical_object_path not None·외부 URL 제외). 보수적: 재전송 중복은 over-count(안전측·캡 초과
    절대 불허). OSS 는 호출 안 됨(is_ee_enabled 게이트·라우터). 초과 시 402 PLAN_LIMIT_EXCEEDED.
    """
    if not attachments:
        return
    tier = await _get_org_tier(session, org_id)
    row = (await session.execute(
        text("SELECT max_storage_mb, max_file_mb FROM plan_tier_limits WHERE tier = :t"),
        {"t": tier},
    )).first()
    if row is None:
        return  # 캡 미정의 tier → 무제한
    max_storage_mb, max_file_mb = int(row[0]), int(row[1])
    max_file_bytes = max_file_mb * 1024 * 1024
    max_storage_bytes = max_storage_mb * 1024 * 1024

    from app.services.asset_registry import canonical_object_path

    new_bytes = 0
    for att in attachments:
        if not isinstance(att, dict) or canonical_object_path(att.get("url") or "") is None:
            continue  # 우리 객체 아님(외부/타버킷) → 우리 storage 미카운트
        try:
            size = max(0, int(att.get("size") or 0))  # 음수 clamp(까심 ②·함수단독 raw 호출 방어·총량 우회 차단)
        except (TypeError, ValueError):
            size = 0
        if size > max_file_bytes:
            raise _storage_limit_error("file_size", max_file_mb, tier)
        new_bytes += size
    if new_bytes == 0:
        return
    used = (await session.execute(
        text("SELECT COALESCE(SUM(size_bytes),0) FROM assets WHERE org_id = :oid AND deleted_at IS NULL"),
        {"oid": str(org_id)},
    )).scalar() or 0
    if int(used) + new_bytes > max_storage_bytes:
        raise _storage_limit_error("storage", max_storage_mb, tier)


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
