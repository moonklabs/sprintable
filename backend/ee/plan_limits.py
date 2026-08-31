"""EE Plan Limit 정책 (E-ORG-MULTI S5.5, story #2776 후속 — seats/max_agents 축 통일).

Org/Project 제한(#2776 스코프 밖 — `offering_versions`에 대응 필드가 없다, PO 確定
2026-08-18: "gating 통일 완료"가 전 축으로 오독되지 않게 이름 박아둠):
  - Org: 사용자당 owner org 1개(하드코딩 유지).
  - Project: org당 1개, free만(하드코딩 유지).

Member/Agent 제한(story #2776, 2026-08-18 — 가격표 정본 `offering_versions`로 통일):
  - seats(휴먼+대기중 초대) — **全 tier**에서 `offering_versions.included_seats`로
    집행(이전엔 free만 하드코딩 3, 나머지 tier는 완전 무제한이었다 — 카탈로그 실측:
    free=3·starter=3·team=5·business=15로 실제 집행 확장됨, PO 判定 안B).
  - `max_agents`(신규 축, 이전엔 코드 어디서도 read 0) — `offering_versions.max_agents`
    (None=무제한, free만 유한 3).
  - **미지 tier 방어**(PO 판정) — org_subscriptions.tier가 알려진 tier(free/starter/
    team/business) 밖의 값이면(예: 0228 마이그가 놓친 'pro' 잔존값) 조용히 free로
    취급하지 않는다(유료 org를 잘못 막을 위험) — fail loud 로그 + 그 요청은 무제한
    통과(안전측 — «막는 사고»보다 «캡 미검사 통과»가 안전).
"""
from __future__ import annotations

import logging

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

FREE_LIMITS: dict[str, int] = {
    "max_orgs_owned": 1,
    "max_projects": 1,
}

# org_subscriptions.tier로 실제 나타날 수 있는, offering_versions가 정의하는 tier 집합.
# 'overage'는 구독 tier가 아니라 사용량과금 축이라 여기 포함 안 됨(구독 tier로 저장되는
# 값이 아님 — 그라운딩 확認).
_KNOWN_TIERS = frozenset({"free", "starter", "team", "business"})

# API 초과 과금 정책 (per call, USD)
API_OVERAGE_RATES: dict[str, float] = {
    "team": 0.001,
    "pro": 0.0005,
}


def _plan_limit_error(resource: str, limit: int, current: int | None = None, tier: str = "free") -> HTTPException:
    upgrade = tier != "business"
    limit_repr = f"{current}/{limit}" if current is not None else str(limit)
    msg = (
        f"{tier} plan {resource} limit ({limit_repr}) reached. Upgrade for more capacity."
        if upgrade else f"{resource} limit ({limit_repr}) reached."
    )
    detail = {
        "code": "PLAN_LIMIT_EXCEEDED",
        "resource": resource,
        "limit": limit,
        "tier": tier,
        "upgrade_required": upgrade,
        "message": msg,
    }
    if current is not None:
        detail["current"] = current
    return HTTPException(status_code=402, detail=detail)


async def _get_org_tier(session: AsyncSession, org_id) -> str:
    """org_subscriptions에서 tier 조회. 레코드 없으면 free."""
    result = await session.execute(
        text("SELECT tier FROM org_subscriptions WHERE org_id = :oid"),
        {"oid": str(org_id)},
    )
    row = result.first()
    return (row[0] if row else None) or "free"


async def _get_offering_limits(session: AsyncSession, tier: str) -> tuple[int, int | None] | None:
    """(included_seats, max_agents) — 가격표 정본. `currency` 무관 조회(그라운딩:
    A1 스코프가 krw_v1만 시드했고 USD 카탈로그는 아직 별도 — seats/max_agents는 좌석 수
    개념이라 통화별로 값이 다를 이유가 없다·둘 다 세팅된 currency 행이면 충분, 결정적
    선택을 위해 currency ASC 1건). 매칭 행이 없으면 None(호출부가 §미지tier방어와 동일
    원칙 — 무제한 통과 + 로그)."""
    row = (await session.execute(
        text(
            "SELECT included_seats, max_agents FROM offering_versions "
            "WHERE tier = :t AND effective_to IS NULL ORDER BY currency ASC LIMIT 1"
        ),
        {"t": tier},
    )).first()
    if row is None:
        return None
    return int(row[0]), (int(row[1]) if row[1] is not None else None)


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
    """Free: org당 project 1개 제한. Team/Pro는 스킵. (#2776 스코프 밖 — 하드코딩 유지)"""
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


def _format_mb(mb: int) -> str:
    return f"{mb / 1024:.1f}GB" if mb >= 1024 else f"{mb}MB"


def _storage_limit_error(resource: str, limit_mb: int, tier: str, *, used_mb: float | None = None) -> HTTPException:
    # story #2906(선생님 확定 2026-08-21, 페드루군 조건ⓐ) — 고객 대면 문구는 한국어로
    # 「현재 사용량/한도」+「무엇을 하면 되는지」를 명시한다(dunning 메일 문안과 같은 규율,
    # #2907 참고). resource="storage"=총량 초과(파일 정리 or 업그레이드 안내),
    # resource="file_size"=단일 파일이 한도 자체를 넘음(정리로는 해결 안 됨, 업그레이드만).
    #
    # 유나양 design 지적(2026-08-21) — business는 더 위 tier가 없어 "업그레이드해
    # 주세요"가 거짓 안내다(업그레이드 불가한데 업그레이드를 권함). upgrade_required
    # (=tier != "business")를 문구 자체에도 배선 — business면 정리/문의로 갈음.
    upgrade_required = tier != "business"
    if resource == "file_size":
        if upgrade_required:
            msg = f"파일 크기가 {tier} 플랜의 파일당 한도({_format_mb(limit_mb)})를 초과했습니다. 더 작은 파일로 업로드하시거나 플랜을 업그레이드해 주세요."
        else:
            msg = f"파일 크기가 {tier} 플랜의 파일당 한도({_format_mb(limit_mb)})를 초과했습니다. 더 작은 파일로 업로드해 주세요."
    else:
        usage_str = f"{used_mb:.0f}MB" if used_mb is not None else "한도"
        if upgrade_required:
            msg = f"저장 공간이 부족합니다({tier} 플랜 한도 {_format_mb(limit_mb)} 중 {usage_str} 사용 중). 기존 파일을 정리하시거나 플랜을 업그레이드해 주세요."
        else:
            msg = f"저장 공간이 부족합니다({tier} 플랜 한도 {_format_mb(limit_mb)} 중 {usage_str} 사용 중). 기존 파일을 정리해 주세요. 추가 용량이 필요하시면 문의해 주세요."
    return HTTPException(
        status_code=402,
        detail={
            "code": "PLAN_LIMIT_EXCEEDED",
            "resource": resource,
            "limit_mb": limit_mb,
            "tier": tier,
            "upgrade_required": upgrade_required,
            "message": msg,
        },
    )


async def _get_org_storage_limits(session: AsyncSession, tier: str) -> tuple[int, int] | None:
    """(storage_mb_limit, max_file_mb) — 가격표 정본(offering_versions). story #2906
    (선생님 확定 2026-08-21) — seats(#2776)와 동일 이관: 이전엔 `plan_tier_limits`(구
    twin)가 SSOT였으나, 카탈로그가 이미 `offering_versions`로 통일된 뒤였다(가격·좌석은
    거기 있는데 storage만 구 테이블에 남아 "경고 임계≠거부 임계" split-brain 위험이
    있었다 — 지금 이 자리서 닫는다). `_get_offering_limits`와 동일 조회 패턴(currency
    무관·ASC 1건, 통화별 값 차이 없음)."""
    row = (await session.execute(
        text(
            "SELECT storage_mb_limit, max_file_mb FROM offering_versions "
            "WHERE tier = :t AND effective_to IS NULL ORDER BY currency ASC LIMIT 1"
        ),
        {"t": tier},
    )).first()
    if row is None:
        return None
    return int(row[0]), int(row[1])


async def get_org_storage_limit_bytes(session: AsyncSession, org_id) -> int | None:
    """org tier 의 storage 캡(bytes). 캡 미정의 tier=None(무제한). storage-usage 표시 공용(server 권위 SSOT)."""
    tier = await _get_org_tier(session, org_id)
    limits = await _get_org_storage_limits(session, tier)
    return limits[0] * 1024 * 1024 if limits else None


async def check_storage_capacity(session: AsyncSession, org_id, attachments: list[dict] | None) -> None:
    """S8(story #2906 갱신, 2026-08-21): org storage 캡 enforce(서버 게이트·all tiers).
    per-file + 총량(committed+신규).

    tier(org_subscriptions)→offering_versions[tier]→캡. 캡 미정의 tier=무제한(no-op).
    **우리 버킷 객체만** 카운트(canonical_object_path not None·외부 URL 제외). **size 는
    head_object authoritative**(까심 ①: client-size:0 quota 우회·음수 size 오염 차단·sync
    와 동일 source). 객체 부재(head None)=미카운트(미등록될 것). OSS 는 호출 안 됨
    (is_ee_enabled 게이트·라우터). 초과 시 402 PLAN_LIMIT_EXCEEDED."""
    if not attachments:
        return
    tier = await _get_org_tier(session, org_id)
    if tier not in _KNOWN_TIERS:
        logger.error("check_storage_capacity: unknown tier %r for org_id=%s — skipping cap(fail-open)", tier, org_id)
        return
    limits = await _get_org_storage_limits(session, tier)
    if limits is None:
        logger.error("check_storage_capacity: no offering_version for tier=%r org_id=%s — skipping cap(fail-open)", tier, org_id)
        return
    max_storage_mb, max_file_mb = limits
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
        raise _storage_limit_error("storage", max_storage_mb, tier, used_mb=int(used) / (1024 * 1024))


async def reject_if_org_over_storage_cap(session: AsyncSession, org_id) -> None:
    """story #3249 — 업로드 발급(presigned URL) 시점의 「선검사」. check_storage_capacity 는
    실 head_object 크기가 있어야(업로드 後) 호출 가능해 발급 단계에선 못 쓴다 — 신규 파일
    크기를 아직 몰라도 판정 가능한 부분만(현재 사용량이 이미 한도 이상인가) 같은 SSOT
    (tier→offering_versions)로 검사해 헛발급을 막는다. 파일별/정확한 총량 판정은 여전히
    confirm 단계의 check_storage_capacity(재검사) 몫."""
    tier = await _get_org_tier(session, org_id)
    if tier not in _KNOWN_TIERS:
        return
    limits = await _get_org_storage_limits(session, tier)
    if limits is None:
        return
    max_storage_mb, _max_file_mb = limits
    max_storage_bytes = max_storage_mb * 1024 * 1024
    used = (await session.execute(
        text("SELECT COALESCE(SUM(size_bytes),0) FROM assets WHERE org_id = :oid AND deleted_at IS NULL"),
        {"oid": str(org_id)},
    )).scalar() or 0
    if int(used) >= max_storage_bytes:
        raise _storage_limit_error("storage", max_storage_mb, tier, used_mb=int(used) / (1024 * 1024))


async def _seat_usage(session: AsyncSession, org_id, *, include_pending_invites: bool) -> int:
    """휴먼 org_members(+옵션: 대기중 미만료 초대) 카운트 — seats 축의 "현재값"(에이전트
    미포함, PO 판정 안B: seats=휴먼 전용)."""
    if include_pending_invites:
        result = await session.execute(
            text(
                "SELECT "
                "(SELECT COUNT(*) FROM org_members WHERE org_id = :oid AND deleted_at IS NULL)"
                " + (SELECT COUNT(*) FROM org_invites"
                "     WHERE organization_id = :oid AND status = 'pending' AND expires_at > now())"
            ),
            {"oid": str(org_id)},
        )
    else:
        result = await session.execute(
            text("SELECT COUNT(*) FROM org_members WHERE org_id = :oid AND deleted_at IS NULL"),
            {"oid": str(org_id)},
        )
    return result.scalar() or 0


async def check_member_invite_limit(session: AsyncSession, org_id) -> None:
    """story #2776 — seats 축을 全 tier에서 카탈로그(`offering_versions.included_seats`)로
    집행(이전엔 free만 하드코딩 3, 나머지 tier 무제한이었음). 여전히 휴먼(org_members)+
    대기중 미만료 초대 합만 센다(에이전트 미포함 — PO 판정 안B, seats 의미 불변).

    story #2477 AC① — pending invite를 안 세면 cap을 우회할 수 있었다(2명이 초대 5개를
    만들어 전부 수락하면 3명 캡을 넘길 수 있음). 생성 단계에서 «멤버+대기중 초대» 합으로
    선차단해 애초에 캡을 넘길 만큼의 초대가 쌓이지 못하게 한다.
    """
    tier = await _get_org_tier(session, org_id)
    if tier not in _KNOWN_TIERS:
        logger.error("check_member_invite_limit: unknown tier %r for org_id=%s — skipping cap(fail-open)", tier, org_id)
        return
    offering = await _get_offering_limits(session, tier)
    if offering is None:
        logger.error("check_member_invite_limit: no offering_version for tier=%r org_id=%s — skipping cap(fail-open)", tier, org_id)
        return
    seats_limit, _max_agents = offering
    count = await _seat_usage(session, org_id, include_pending_invites=True)
    if count >= seats_limit:
        raise _plan_limit_error("member", seats_limit, current=count, tier=tier)


async def check_member_accept_limit(session: AsyncSession, org_id) -> None:
    """story #2776 — §check_member_invite_limit과 동일 카탈로그 소스, 全 tier 집행.
    초대 «수락» 시점 재검증(story #2477 AC②) — 현재 멤버수만 비교(대기중 초대는 무관,
    이 호출이 성공하면 그 초대 하나가 바로 멤버로 전환되므로).

    ⚠️호출부(OrgInviteRepository.accept)가 org_id 스코프 advisory xact lock을 먼저 잡은
    뒤에 불러야 한다 — 락 없이 재면 동시에 수락하는 두 트랜잭션이 서로 상대의 INSERT를
    못 본 채 똑같이 "아직 cap 안 참"으로 읽어 둘 다 통과해버린다(AC③ 레이스 방어는 이
    함수가 아니라 호출부의 락이 담당).
    """
    tier = await _get_org_tier(session, org_id)
    if tier not in _KNOWN_TIERS:
        logger.error("check_member_accept_limit: unknown tier %r for org_id=%s — skipping cap(fail-open)", tier, org_id)
        return
    offering = await _get_offering_limits(session, tier)
    if offering is None:
        logger.error("check_member_accept_limit: no offering_version for tier=%r org_id=%s — skipping cap(fail-open)", tier, org_id)
        return
    seats_limit, _max_agents = offering
    count = await _seat_usage(session, org_id, include_pending_invites=False)
    if count >= seats_limit:
        raise _plan_limit_error("member", seats_limit, current=count, tier=tier)


async def check_agent_add_limit(session: AsyncSession, org_id) -> None:
    """story #2776 신규 — `offering_versions.max_agents` 축 집행(이전엔 코드 어디서도
    read 0이던 그 값). None=무제한(free만 유한 3). 미지 tier/미시드 offering은 §미지tier
    방어와 동일 원칙(fail-open+로그) — 유료 org를 잘못 막지 않는다."""
    tier = await _get_org_tier(session, org_id)
    if tier not in _KNOWN_TIERS:
        logger.error("check_agent_add_limit: unknown tier %r for org_id=%s — skipping cap(fail-open)", tier, org_id)
        return
    offering = await _get_offering_limits(session, tier)
    if offering is None:
        logger.error("check_agent_add_limit: no offering_version for tier=%r org_id=%s — skipping cap(fail-open)", tier, org_id)
        return
    _seats, max_agents = offering
    if max_agents is None:
        return  # 무제한 tier
    count = (await session.execute(
        text(
            "SELECT COUNT(*) FROM members "
            "WHERE org_id = :oid AND type = 'agent' AND is_active = true AND deleted_at IS NULL"
        ),
        {"oid": str(org_id)},
    )).scalar() or 0
    if count >= max_agents:
        raise _plan_limit_error("agent", max_agents, current=count, tier=tier)
