import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from jose import JWTError
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import decode_jwt_ignore_exp, hash_token
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.organization import Organization
from app.models.team import TeamMember
from app.models.user import RefreshToken, User
from app.schemas.subscription import AccountDeleteResponse

router = APIRouter(prefix="/api/v2/account", tags=["account"])

# FE switcher 는 복수형 `/api/v2/accounts/resolve` 를 호출(라이브 회귀: BE 미구현 404 → 전 계정 "Unknown").
accounts_router = APIRouter(prefix="/api/v2/accounts", tags=["accounts"])


class AccountResolveRequest(BaseModel):
    refresh_tokens: list[str]


class AccountMeta(BaseModel):
    account_id: str
    name: str | None = None
    email: str | None = None
    org_name: str | None = None
    avatar_url: str | None = None
    status: str  # active | expired


class AccountResolveResponse(BaseModel):
    accounts: list[AccountMeta]


@accounts_router.post(
    "/resolve", response_model=AccountResolveResponse, response_model_exclude_none=True
)
async def resolve_accounts(
    body: AccountResolveRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> AccountResolveResponse:
    """switcher 계정 메타 resolve — vault RT 들을 **decode-only**(rotate/revoke 부작용 0·FE RC3).

    우리 서명 검증된 refresh 토큰만 처리(임의 토큰 정보 leak 0). 만료 토큰도 sub 추출해 status=expired
    로 표시(재로그인 유도). 호출자 인증(Bearer) 필요.
    """
    now = datetime.now(timezone.utc)
    # 계정(sub)별 **active 우선 병합**(까심 minor#2): 동일 sub 토큰이 여럿이면 토큰 순서와 무관하게
    # active 가 expired 를 이긴다(만료 토큰이 먼저 와도 active 계정이 expired 로 표시되지 않게).
    by_sub: dict[str, AccountMeta] = {}
    for rt in body.refresh_tokens:
        try:
            claims = decode_jwt_ignore_exp(rt)
        except JWTError:
            continue  # 우리 서명 아님/손상 → skip(graceful)
        if claims.get("type") != "refresh":
            continue
        sub = claims.get("sub")
        if not sub:
            continue
        existing = by_sub.get(str(sub))
        if existing is not None and existing.status == "active":
            continue  # 이미 active 확정 — 추가 토큰 무시(중복 쿼리 회피)
        try:
            uid = uuid.UUID(str(sub))
        except ValueError:
            continue

        # active = (DB 저장된 토큰: hash+user_id 일치·non-revoked·non-expired) AND JWT 미만료.
        # ⚠️ 까심: 미저장 signed RT 가 active 표시되면 안 됨(hash+uid row 요구)·만료/취소 RT 는
        # PII 미반환(stale RT 만으로 name/email/org/avatar 노출 차단). 비활성=최소 {account_id,status}.
        jwt_expired = int(claims.get("exp", 0)) < int(now.timestamp())
        active_row = (await session.execute(
            select(RefreshToken.id).where(
                RefreshToken.token_hash == hash_token(rt),
                RefreshToken.user_id == uid,
                RefreshToken.revoked_at.is_(None),
                RefreshToken.expires_at > now,
            )
        )).scalar_one_or_none()

        if jwt_expired or active_row is None:
            meta = AccountMeta(account_id=str(sub), status="expired")  # PII 없음
        else:
            user = (await session.execute(select(User).where(User.id == uid))).scalar_one_or_none()
            if user is None:
                meta = AccountMeta(account_id=str(sub), status="expired")
            else:
                org_name = None
                if user.last_org_id is not None:
                    org_name = (await session.execute(
                        select(Organization.name).where(Organization.id == user.last_org_id)
                    )).scalar_one_or_none()
                avatar_url = (await session.execute(
                    select(TeamMember.avatar_url).where(TeamMember.user_id == uid).limit(1)
                )).scalar_one_or_none()
                meta = AccountMeta(
                    account_id=str(sub),
                    name=user.display_name,
                    email=user.email,
                    org_name=org_name,
                    avatar_url=avatar_url,
                    status="active",
                )

        # active 우선 병합: active 면 무조건 덮고, 아니면 빈 자리에만 채운다.
        if existing is None or meta.status == "active":
            by_sub[str(sub)] = meta
    return AccountResolveResponse(accounts=list(by_sub.values()))


@router.post("/delete", response_model=AccountDeleteResponse)
async def delete_account(
    org_id: uuid.UUID = Depends(get_verified_org_id),
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> AccountDeleteResponse:
    now = datetime.now(timezone.utc).isoformat()
    uid = auth.user_id

    await session.execute(
        text("UPDATE org_members SET deleted_at = :now WHERE user_id = :uid::uuid"),
        {"now": now, "uid": str(uid)},
    )
    # AC3-4 2-2: team_members 뷰 전환 — anchor-only. members가 is_active/deleted_at 유일 소스.
    await session.execute(
        text(
            "UPDATE members SET deleted_at = :now, is_active = false, updated_at = :now"
            " WHERE user_id = :uid::uuid"
        ),
        {"now": now, "uid": str(uid)},
    )

    return AccountDeleteResponse(ok=True, grace_period_days=30)
