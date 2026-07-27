import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.dependencies.ownership import _is_org_admin
from app.models.trust_snapshot import OrgMemberTrustSnapshot
from app.services.member_resolver import is_caller_member
from app.services.trust_score import DEFAULT_WINDOW_DAYS, compute_and_snapshot

router = APIRouter(prefix="/api/v2/trust-scores", tags=["trust-scores", "Organization"])


async def _assert_self_or_org_admin(
    member_id: uuid.UUID, auth: AuthContext, session: AsyncSession, org_id: uuid.UUID,
) -> None:
    if await is_caller_member(member_id, auth, session, org_id):
        return
    if await _is_org_admin(session, org_id, uuid.UUID(auth.user_id)):
        return
    raise HTTPException(status_code=403, detail="Not authorized for this member")


async def _assert_org_admin(session: AsyncSession, org_id: uuid.UUID, auth: AuthContext) -> None:
    if await _is_org_admin(session, org_id, uuid.UUID(auth.user_id)):
        return
    raise HTTPException(status_code=403, detail="Not authorized — org admin only")


@router.get("")
async def get_trust_scores(
    member_id: uuid.UUID = Query(...),
    role: str | None = Query(default=None),
    window_days: int = Query(default=DEFAULT_WINDOW_DAYS, ge=1, le=365),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    # S20 전수스캔 findings #11: member_id에 caller-ownership 확인이 전혀 없어 임의 org member가
    # 다른 member의 신뢰점수(성과 유사 민감정보)를 열람할 수 있었다 — rewards.get_balance와 동형.
    await _assert_self_or_org_admin(member_id, auth, session, org_id)
    # story 91404248(C2a): compute_member_trust_scores() 산식은 불변 — lazy write-through로
    # org_member_trust_snapshots에 부수효과 저장만 추가(응답 계약 100% 동일).
    return await compute_and_snapshot(
        session=session,
        org_id=org_id,
        member_id=member_id,
        role_key=role,
        window_days=window_days,
    )


@router.get("/org-summary")
async def get_trust_org_summary(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """story 91404248(C2a): org-c2-trust-persistence-design §4a — 조직 로스터 현재값.

    member×role별 최신 스냅샷 1건. admin-only(로스터 전체 열람은 self 예외 없음 — 다른
    member 신뢰점수를 보는 행위 자체가 이미 admin 전용 시맨틱, trust-scores 기존 판단 계승).
    스냅샷이 아예 없는 member×role은 목록에서 생략(부분 목록 — 콜드스타트, IDOR 아님).
    """
    await _assert_org_admin(session, org_id, auth)

    latest_ids_subq = (
        select(
            OrgMemberTrustSnapshot.member_id,
            OrgMemberTrustSnapshot.role_key,
            func.max(OrgMemberTrustSnapshot.computed_at).label("max_computed_at"),
        )
        .where(OrgMemberTrustSnapshot.org_id == org_id)
        .group_by(OrgMemberTrustSnapshot.member_id, OrgMemberTrustSnapshot.role_key)
        .subquery()
    )
    q = select(OrgMemberTrustSnapshot).join(
        latest_ids_subq,
        (OrgMemberTrustSnapshot.member_id == latest_ids_subq.c.member_id)
        & (OrgMemberTrustSnapshot.role_key == latest_ids_subq.c.role_key)
        & (OrgMemberTrustSnapshot.computed_at == latest_ids_subq.c.max_computed_at),
    ).where(OrgMemberTrustSnapshot.org_id == org_id)
    rows = (await session.execute(q)).scalars().all()

    return {
        "members": [
            {
                "member_id": str(row.member_id),
                "role_key": row.role_key,
                "role_label": row.metrics.get("role_label"),
                "hit_rate": row.metrics.get("hit_rate"),
                "resolved": row.metrics.get("resolved"),
                "computed_at": row.computed_at.isoformat(),
            }
            for row in rows
        ]
    }


@router.get("/history")
async def get_trust_history(
    member_id: uuid.UUID = Query(...),
    role: str = Query(...),
    limit: int = Query(default=50, ge=1, le=500),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """story 91404248(C2a): org-c2-trust-persistence-design §4b — 멤버 드릴다운 추이.

    self-or-admin(본인 추이는 볼 수 있어야 함 — 기존 GET /trust-scores 권한 재사용).
    """
    await _assert_self_or_org_admin(member_id, auth, session, org_id)

    q = (
        select(OrgMemberTrustSnapshot)
        .where(
            OrgMemberTrustSnapshot.org_id == org_id,
            OrgMemberTrustSnapshot.member_id == member_id,
            OrgMemberTrustSnapshot.role_key == role,
        )
        .order_by(OrgMemberTrustSnapshot.computed_at.desc())
        .limit(limit)
    )
    rows = (await session.execute(q)).scalars().all()

    return {
        "member_id": str(member_id),
        "role_key": role,
        "snapshots": [
            {"computed_at": row.computed_at.isoformat(), **row.metrics}
            for row in rows
        ],
    }
