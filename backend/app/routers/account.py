import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from jose import JWTError
from pydantic import BaseModel
from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import decode_jwt_ignore_exp, hash_token
from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.auth_identity import AuthMigration
from app.models.organization import Organization
from app.models.team import TeamMember
from app.models.user import RefreshToken, User
from app.schemas.subscription import AccountDeleteResponse
from app.services.account_purge import ACCOUNT_PURGE_GRACE_DAYS

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/account", tags=["account", "Organization"])

# FE switcher 는 복수형 `/api/v2/accounts/resolve` 를 호출(라이브 회귀: BE 미구현 404 → 전 계정 "Unknown").
accounts_router = APIRouter(prefix="/api/v2/accounts", tags=["accounts", "Organization"])


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
                    select(TeamMember.avatar_url).where(TeamMember.user_id == uid).order_by(TeamMember.project_id, TeamMember.id).limit(1)
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


async def _plan_organizations(session: AsyncSession, uid: uuid.UUID, *, lock: bool) -> tuple[list[dict], list[dict]]:
    """story #4752 AC4: «other people» are exactly the people the members screen shows: the live `org_members` rows of the organization (`GET /api/v2/org-members` — `deleted_at IS NULL`,
    whatever the state of their own account; routers/org_members.py `list_org_members`, the screen the 409 sends the person to). A human who exists only as a `members` row (no live seat) is
    not on that screen, so they are not counted (nobody to hand over to; closing deletes nothing a person can see); an account that is deactivated but still seated IS on it, so it counts
    (closing would delete someone's visible data). Agents are `members` rows, not seats: not counted.
    The organizations that CLOSE with the person's account (nobody else active in them) and the ones that BLOCK the deletion — `reason`
    `other_members` (the person is the only active owner and others are in it: hand it over) or `active_subscription` (a closing organization with a paid/in-flight subscription:
    cancel it first). `lock` locks the organization rows in id order (the deletion); the preview does not."""
    from app.repositories.organization import OrganizationRepository

    if lock:
        # The LOCK is a statement of its own and the COUNT a later one: under READ COMMITTED a statement that waits for a row lock still reads its other tables (org_members) as of the
        # statement's start, so counting in the same statement would not see an owner who left while this one waited (two co-owners deleting at once both got through and the
        # organization kept no owner — Kadir on 5189, pinned by test_20/21). Rows in id order, so two of these cannot deadlock.
        await session.execute(
            text(
                "SELECT o.id FROM organizations o WHERE o.id IN ("
                " SELECT om.org_id FROM org_members om WHERE om.user_id = CAST(:uid AS uuid) AND om.deleted_at IS NULL)"
                " ORDER BY o.id FOR UPDATE OF o"
            ),
            {"uid": str(uid)},
        )
    rows = (await session.execute(
        text(
            "SELECT o.id, o.name, om.role,"
            " (SELECT count(*) FROM org_members x"
            "   WHERE x.org_id = o.id AND x.deleted_at IS NULL AND x.user_id <> CAST(:uid AS uuid)) AS other_members,"
            " (SELECT count(*) FROM org_members x"
            "   WHERE x.org_id = o.id AND x.deleted_at IS NULL AND x.role = 'owner' AND x.user_id <> CAST(:uid AS uuid)) AS other_owners"
            " FROM organizations o JOIN org_members om ON om.org_id = o.id"
            " WHERE om.user_id = CAST(:uid AS uuid) AND om.deleted_at IS NULL"
            " ORDER BY o.id"
        ),
        {"uid": str(uid)},
    )).all()
    repo = OrganizationRepository(session)
    closing: list[dict] = []
    blocked: list[dict] = []
    for row in rows:
        entry = {"id": str(row.id), "name": row.name}
        if row.other_members == 0:
            if await repo._has_active_or_in_flight_subscription(row.id):
                blocked.append({**entry, "reason": "active_subscription"})
            else:
                closing.append(entry)
        elif row.role == "owner" and row.other_owners == 0:
            blocked.append({**entry, "reason": "other_members"})
    return closing, blocked


@router.get("/delete-preview")
async def delete_account_preview(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """story #4752 AC4: what the account deletion would do to the person's organizations — `closing` (they close with the account) and `blocked` (the deletion is refused until each is
    dealt with; `reason` as in the 409 of the deletion). Read only; the confirmation window shows it before «삭제 확인»."""
    if (auth.claims.get("app_metadata") or {}).get("human_api_key_id"):
        raise HTTPException(status_code=403, detail="An API key cannot delete the account")
    try:
        uid = uuid.UUID(str(auth.user_id))
    except ValueError:
        raise HTTPException(status_code=404, detail="Account not found") from None
    user = (await session.execute(select(User).where(User.id == uid))).scalar_one_or_none()
    if user is None or not user.is_active or user.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Account not found")
    closing, blocked = await _plan_organizations(session, uid, lock=False)
    return {"closing": closing, "blocked": blocked}


@router.post("/delete", response_model=AccountDeleteResponse)
async def delete_account(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> AccountDeleteResponse:
    """The person deletes their OWN account (a store requirement: it must be reachable from the app, whatever state the account is in).

    story #4752 — three things this endpoint did not do:
    ① it asked for an organization (`get_verified_org_id`): a person with none could not delete their account at all (403). The account is the person's own, whether or not an
       organization stands: nothing here needs one.
    ② the account stayed alive: only the memberships got `deleted_at`, so the same password still signed in (and the web's onboarding made the person a new organization).
       Now the user row is closed — `is_active` false + `deleted_at` — and every lookup that signs a person in (password · refresh · provider id · reset mail) already
       filters on `is_active`.
    ③ nothing ever removed the personal data the copy promises («30일 유예 기간 후 …»): the purge job (`services/account_purge.py`, cron `account-purge`) counts from `deleted_at`.
    Human only: a human API key (`hu_live_`) is a way to READ and write work, never to close the person's account; an agent key names a member, not a user, so no account is found.
    """
    if (auth.claims.get("app_metadata") or {}).get("human_api_key_id"):
        raise HTTPException(status_code=403, detail="An API key cannot delete the account")
    try:
        uid = uuid.UUID(str(auth.user_id))
    except ValueError:
        raise HTTPException(status_code=404, detail="Account not found") from None
    user = (await session.execute(select(User).where(User.id == uid).with_for_update())).scalar_one_or_none()
    if user is None or not user.is_active or user.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Account not found")  # another person's id, an agent key's member, or an account already deleted: the same answer

    # story #4752 AC4 (PO rule, revised 5779): what happens to the organizations of the person —
    #   · nobody else is active in it → it CLOSES with the account (the owner's organization delete, whatever the person's role); an active/in-flight subscription stops it;
    #   · other people are in it and the person is its only active owner → the account cannot be deleted until ownership is handed over (or the organization is dealt with);
    #   · another owner stays, or the person is not an owner of a populated organization → nothing to do.
    # Without this the organization would stay with no owner / as an empty shell / with a subscription nobody can cancel. The organization rows are locked in id order so two
    # co-owners deleting at once cannot both pass (the second then finds itself the only owner left).
    closing, blocked = await _plan_organizations(session, uid, lock=True)
    if blocked:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "ORG_BLOCKS_ACCOUNT_DELETE",
                "message": "An organization of the account needs attention first: hand it to another owner, or cancel its subscription",
                "orgs": blocked,
            },
        )
    from app.repositories.organization import OrganizationRepository

    repo = OrganizationRepository(session)
    for org in closing:
        closed = await repo.delete_for_account_closure(uuid.UUID(org["id"]), uid)
        if not closed["ok"] and closed.get("reason") != "not_found":
            await session.rollback()   # a subscription began between the check and the closing: nothing of this deletion is kept
            raise HTTPException(
                status_code=409,
                detail={"code": "ORG_BLOCKS_ACCOUNT_DELETE", "message": "An organization of the account needs attention first: hand it to another owner, or cancel its subscription",
                        "orgs": [{"id": org["id"], "name": org["name"], "reason": "other_members" if closed.get("reason") == "members_joined" else "active_subscription"}]},
            )

    # story #4767: the computers this person confirmed in an organization that stays — closed like a disconnect (keys, device token, open commands and
    # stream), so a deleted person's Mac cannot keep reaching the relay. In its own savepoint: the deletion is a store requirement and must not fail because
    # a computer could not be closed — and a device whose confirming person is gone is refused at authentication anyway (`device_for_token`), so a failure
    # here leaves nothing open.
    try:
        async with session.begin_nested():
            from app.services.desktop_setup import close_setups_of_deleted_account

            await close_setups_of_deleted_account(session, user_id=uid)
    except Exception:
        logger.exception("account deletion: closing the person's computers failed user_id=%s (devices are still refused at authentication)", uid)

    now = datetime.now(timezone.utc)
    await session.execute(
        text("UPDATE org_members SET deleted_at = :now WHERE user_id = CAST(:uid AS uuid) AND deleted_at IS NULL"),
        {"now": now, "uid": str(uid)},
    )
    # AC3-4 2-2: team_members 뷰 전환 — anchor-only. members가 is_active/deleted_at 유일 소스.
    await session.execute(
        text(
            "UPDATE members SET deleted_at = :now, is_active = false, updated_at = :now"
            " WHERE user_id = CAST(:uid AS uuid) AND deleted_at IS NULL"
        ),
        {"now": now, "uid": str(uid)},
    )
    # the person's phones stop receiving pushes with the deletion, in the same transaction (rows not backfilled carry `user_id` NULL, so the member side is needed too — story #4752, Kadir's K8)
    await session.execute(
        text(
            "UPDATE push_devices SET is_active = false WHERE is_active AND (user_id = CAST(:uid AS uuid)"
            " OR member_id IN (SELECT id FROM members WHERE user_id = CAST(:uid AS uuid)))"
        ),
        {"uid": str(uid)},
    )
    user.is_active = False
    user.deleted_at = now
    # story #4400 (Qadir 01a0e9fc) — end every session of the deleted account, like the admin removal does
    # (org_members._revoke_user_refresh_tokens · the same _explicit_revoke_values seam). Before, its refresh tokens stayed
    # valid and could keep re-issuing a departed org.
    from app.routers.org_members import _revoke_user_refresh_tokens

    await _revoke_user_refresh_tokens(session, uuid.UUID(str(uid)))
    # …and every ACCESS token already issued: the per-user cut-off epoch (`auth_migrations.auth_valid_after`, read by `_reject_if_before_cutover` on every request) — the last instant of the
    # CURRENT second, as the reclaim of an unproved account does it (tokens carry whole seconds). Without it a token minted before the deletion kept working until its own expiry.
    epoch = now.replace(microsecond=0) + timedelta(seconds=1) - timedelta(microseconds=1)
    upsert = pg_insert(AuthMigration).values(user_id=uid, state="legacy", auth_valid_after=epoch)
    await session.execute(upsert.on_conflict_do_update(
        index_elements=[AuthMigration.user_id],
        set_={"auth_valid_after": func.greatest(AuthMigration.auth_valid_after, upsert.excluded.auth_valid_after)},
    ))

    return AccountDeleteResponse(ok=True, grace_period_days=ACCOUNT_PURGE_GRACE_DAYS)
