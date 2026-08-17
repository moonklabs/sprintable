"""EE Plan Limit 정책 (E-ORG-MULTI S5.5).

Free 플랜 제한:
  - Org: 사용자당 1개 (owner 기준)
  - Project: org당 1개
  - Member: org당 3명 (#2471 A1 — v2.3 정책·선생님 確定 2026-08-06 04:00Z. 강제 마이그
    아님: 기존 3명 초과 Free org는 멤버를 그대로 두고 신규 초대만 막는다 — 이 파일의 다른
    모든 초과-자원 처리(storage: 신규 업로드만 차단·기존 파일 유지)와 동일한 패턴.)

Team/Pro: 제한 없음.
"""
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

FREE_LIMITS: dict[str, int] = {
    "max_orgs_owned": 1,
    "max_projects": 1,
    "max_members": 3,
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
    카운트(canonical_object_path not None·외부 URL 제외). **size 는 head_object authoritative**(까심 ①:
    client-size:0 quota 우회·음수 size 오염 차단·sync 와 동일 source). 객체 부재(head None)=미카운트(미등록될
    것). OSS 는 호출 안 됨(is_ee_enabled 게이트·라우터). 초과 시 402 PLAN_LIMIT_EXCEEDED.
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

    from app.services.asset_registry import DEFAULT_CONTAINER, canonical_object_path
    from app.services.storage import get_storage_provider

    provider = get_storage_provider()
    new_bytes = 0
    for att in attachments:
        if not isinstance(att, dict):
            continue
        obj = canonical_object_path(att.get("url") or "", DEFAULT_CONTAINER)
        if obj is None:
            continue  # 우리 객체 아님(외부/타버킷) → 미카운트
        size = await provider.head_object(DEFAULT_CONTAINER, obj)  # authoritative(client size 무시·까심①)
        if size is None:
            continue  # 객체 부재 = 미카운트(미등록될 것)
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
    """Free: org당 member 3명 제한 (human + agent, 현재 멤버 + pending 미만료 초대 합). Team/Pro는 스킵.

    story #2477 AC① — pending invite를 안 세면 cap을 우회할 수 있었다(2명이 초대 5개를
    만들어 전부 수락하면 3명 캡을 넘길 수 있음). 생성 단계에서 «멤버+대기중 초대» 합으로
    선차단해 애초에 캡을 넘길 만큼의 초대가 쌓이지 못하게 한다.
    """
    tier = await _get_org_tier(session, org_id)
    if tier != "free":
        return
    result = await session.execute(
        text(
            "SELECT "
            "(SELECT COUNT(*) FROM org_members WHERE org_id = :oid AND deleted_at IS NULL)"
            " + (SELECT COUNT(*) FROM org_invites"
            "     WHERE organization_id = :oid AND status = 'pending' AND expires_at > now())"
        ),
        {"oid": str(org_id)},
    )
    count = result.scalar() or 0
    if count >= FREE_LIMITS["max_members"]:
        raise _plan_limit_error("member", FREE_LIMITS["max_members"])


async def check_member_accept_limit(session: AsyncSession, org_id) -> None:
    """Free: 초대 «수락» 시점 재검증(story #2477 AC②) — 현재 멤버수만 비교(대기중 초대는
    무관, 이 호출이 성공하면 그 초대 하나가 바로 멤버로 전환되므로). Team/Pro는 스킵.

    ⚠️호출부(OrgInviteRepository.accept)가 org_id 스코프 advisory xact lock을 먼저 잡은
    뒤에 불러야 한다 — 락 없이 재면 동시에 수락하는 두 트랜잭션이 서로 상대의 INSERT를
    못 본 채 똑같이 "아직 cap 안 참"으로 읽어 둘 다 통과해버린다(AC③ 레이스 방어는 이
    함수가 아니라 호출부의 락이 담당).
    """
    tier = await _get_org_tier(session, org_id)
    if tier != "free":
        return
    result = await session.execute(
        text("SELECT COUNT(*) FROM org_members WHERE org_id = :oid AND deleted_at IS NULL"),
        {"oid": str(org_id)},
    )
    count = result.scalar() or 0
    if count >= FREE_LIMITS["max_members"]:
        raise _plan_limit_error("member", FREE_LIMITS["max_members"])
