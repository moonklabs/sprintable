from __future__ import annotations

import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
import re

from pydantic import BaseModel, field_validator

_EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$")


def _normalize_email(v: str) -> str:
    v = v.strip().lower()
    if not _EMAIL_RE.match(v):
        raise ValueError("Invalid email format")
    return v
from sqlalchemy.exc import IntegrityError
from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings

from app.core.security import (
    create_tokens,
    create_password_reset_token,
    create_email_verification_token,
    create_oauth_state_token,
    decode_jwt,
    decode_password_reset_token,
    decode_email_verification_token,
    decode_oauth_state_token,
    generate_totp_secret,
    get_totp_provisioning_uri,
    hash_password,
    hash_token,
    verify_password,
    verify_totp,
    verify_totp_with_timestep,
    JWTError,
    REFRESH_TOKEN_EXPIRE_DAYS,
    create_refresh_token,
)
from app.core.rate_limit import limiter
from app.dependencies.auth import AuthContext, get_current_user
from app.services.project_auth import has_project_access, first_accessible_project_id
from app.dependencies.database import get_db
from app.models.invitation import Invitation
from app.models.org_invite import OrgInvite
from app.models.project import OrgMember
from app.models.team import TeamMember
from app.models.login_audit_log import LoginAuditLog
from app.models.user import RefreshToken, User

router = APIRouter(prefix="/api/v2/auth", tags=["auth"])


async def _write_audit(
    session: AsyncSession,
    event_type: str,
    *,
    user_id: uuid.UUID | None = None,
    email: str | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
    detail: str | None = None,
) -> None:
    session.add(LoginAuditLog(
        event_type=event_type,
        user_id=user_id,
        email=email,
        ip_address=ip_address,
        user_agent=user_agent,
        detail=detail,
    ))


def _ok(data: object, status_code: int = 200) -> JSONResponse:
    return JSONResponse({"data": data, "error": None, "meta": None}, status_code=status_code)


def _err(code: str, message: str, status_code: int = 400) -> JSONResponse:
    return JSONResponse(
        {"data": None, "error": {"code": code, "message": message}, "meta": None},
        status_code=status_code,
    )


# ─── Schemas ──────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: str
    password: str
    totp_code: str | None = None

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        return _normalize_email(v)


class RegisterRequest(BaseModel):
    email: str
    password: str
    display_name: str  # AC3: 필수
    tos_accepted: bool = False
    invite_token: str | None = None  # AC2: 초대 토큰 (가입 후 자동 수락)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        return _normalize_email(v)

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters long")
        categories = [
            bool(re.search(r"[A-Z]", v)),
            bool(re.search(r"[a-z]", v)),
            bool(re.search(r"\d", v)),
            bool(re.search(r"[^A-Za-z0-9]", v)),
        ]
        if sum(categories) < 3:
            raise ValueError(
                "Password must include at least 3 of: uppercase letters, lowercase letters, digits, special characters"
            )
        return v


class RefreshRequest(BaseModel):
    refresh_token: str


class LogoutRequest(BaseModel):
    refresh_token: str


class TotpVerifyRequest(BaseModel):
    code: str


class ForgotPasswordRequest(BaseModel):
    email: str

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        return _normalize_email(v)


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters long")
        categories = [
            bool(re.search(r"[A-Z]", v)),
            bool(re.search(r"[a-z]", v)),
            bool(re.search(r"\d", v)),
            bool(re.search(r"[^A-Za-z0-9]", v)),
        ]
        if sum(categories) < 3:
            raise ValueError(
                "Password must include at least 3 of: uppercase letters, lowercase letters, digits, special characters"
            )
        return v


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters long")
        categories = [
            bool(re.search(r"[A-Z]", v)),
            bool(re.search(r"[a-z]", v)),
            bool(re.search(r"\d", v)),
            bool(re.search(r"[^A-Za-z0-9]", v)),
        ]
        if sum(categories) < 3:
            raise ValueError(
                "Password must include at least 3 of: uppercase letters, lowercase letters, digits, special characters"
            )
        return v


class SetPasswordRequest(BaseModel):
    new_password: str

    @field_validator("new_password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters long")
        categories = [
            bool(re.search(r"[A-Z]", v)),
            bool(re.search(r"[a-z]", v)),
            bool(re.search(r"\d", v)),
            bool(re.search(r"[^A-Za-z0-9]", v)),
        ]
        if sum(categories) < 3:
            raise ValueError(
                "Password must include at least 3 of: uppercase letters, lowercase letters, digits, special characters"
            )
        return v


# ─── Helpers ──────────────────────────────────────────────────────────────────

async def _auto_accept_invitation(session: AsyncSession, user: User, invite_token: str) -> None:
    """가입 시 invite_token이 있으면 해당 초대 자동 수락 + org_member 생성."""
    from app.models.invitation import Invitation
    result = await session.execute(
        select(Invitation).where(Invitation.token == invite_token)
    )
    inv = result.scalar_one_or_none()
    if inv is None or inv.status != "pending" or inv.expires_at < datetime.now(timezone.utc):
        return
    if inv.email.lower() != user.email.lower():
        return
    inv.status = "accepted"
    inv.accepted_at = datetime.now(timezone.utc)
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    await session.execute(
        pg_insert(OrgMember)
        .values(org_id=inv.org_id, user_id=user.id, role=inv.role)
        .on_conflict_do_nothing(constraint="uq_org_members_org_user")
    )
    await session.flush()


async def _get_user_by_email(session: AsyncSession, email: str) -> User | None:
    result = await session.execute(select(User).where(User.email == email, User.is_active.is_(True)))
    return result.scalar_one_or_none()


async def _get_user_by_id(session: AsyncSession, user_id: uuid.UUID) -> User | None:
    result = await session.execute(select(User).where(User.id == user_id, User.is_active.is_(True)))
    return result.scalar_one_or_none()


async def _build_app_metadata(user: User, session: AsyncSession) -> dict:
    from app.models.team import TeamMember

    # 1. last_project_id 우선 → 해당 project의 active team_member
    member = None
    if getattr(user, "last_project_id", None):
        result = await session.execute(
            select(TeamMember)
            .where(
                TeamMember.project_id == user.last_project_id,
                or_(TeamMember.user_id == user.id, TeamMember.id == user.id),
                TeamMember.is_active.is_(True),
            )
            .limit(1)
        )
        member = result.scalar_one_or_none()

    if not member:
        # fallback: 가장 오래된 team_member (ASC) — 최초 가입 project 우선
        result = await session.execute(
            select(TeamMember)
            .where(
                or_(TeamMember.user_id == user.id, TeamMember.id == user.id),
                TeamMember.is_active.is_(True),
            )
            .order_by(TeamMember.created_at.asc())
            .limit(1)
        )
        member = result.scalar_one_or_none()

    if member and member.user_id is None:
        member.user_id = user.id

    if not member:
        # 2. 이메일로 pending 초대 조회 → 자동 수락 + org_member 생성
        # 2a. Invitation (invitations 테이블 — /api/v2/invitations 경로)
        now = datetime.now(timezone.utc)
        inv_result = await session.execute(
            select(Invitation).where(
                Invitation.email == user.email,
                Invitation.status == "pending",
                Invitation.expires_at > now,
            ).order_by(Invitation.created_at.asc()).limit(1)
        )
        inv = inv_result.scalar_one_or_none()
        if inv:
            inv.status = "accepted"
            inv.accepted_at = now
            from sqlalchemy.dialects.postgresql import insert as pg_insert
            await session.execute(
                pg_insert(OrgMember)
                .values(org_id=inv.org_id, user_id=user.id, role=inv.role)
                .on_conflict_do_nothing(constraint="uq_org_members_org_user")
            )
            # human team_member 생성 제거 — org_members 기반 opt-out 모델로 이전 (E-ENTITY-CLEANUP S5).
            await session.flush()
            return {
                "org_id": str(inv.org_id),
                "project_id": str(inv.project_id) if inv.project_id else "",
                "role": inv.role,
            }

        # 2b. OrgInvite (org_invites 테이블 — /api/v2/invites 경로)
        # invite link 가입 후 explicit accept 없이 로그인 시 자동 수락 fallback.
        org_inv_result = await session.execute(
            select(OrgInvite).where(
                OrgInvite.email == user.email.lower(),
                OrgInvite.status == "pending",
                OrgInvite.expires_at > now,
            ).order_by(OrgInvite.created_at.asc()).limit(1)
        )
        org_inv = org_inv_result.scalar_one_or_none()
        if org_inv:
            from sqlalchemy.dialects.postgresql import insert as pg_insert
            await session.execute(
                pg_insert(OrgMember)
                .values(org_id=org_inv.organization_id, user_id=user.id, role=org_inv.role)
                .on_conflict_do_nothing(constraint="uq_org_members_org_user")
            )
            org_inv.status = "accepted"
            org_inv.accepted_at = now
            await session.flush()
            return {
                "org_id": str(org_inv.organization_id),
                "project_id": "",
                "role": org_inv.role,
            }

    if not member:
        # Path 4: org_members fallback — team_member 없지만 org에는 등록된 사용자.
        # AC2-2b(3dfcada4): team_member auto-INSERT 제거 — org-member 휴먼 로그인마다 곱연산
        #   team_member를 재생산하던 드리프트 소스(AC2-2 무효화). org-member 휴먼은 AC2-2의
        #   has_project_access/grant 경로로 인가되므로 team_member 행 없이 로그인·진입 정상.
        # 착지 project는 first_accessible_project_id(team_member ∪ grant ∪ owner/admin)로 결정.
        org_member_result = await session.execute(
            select(OrgMember)
            .where(OrgMember.user_id == user.id, OrgMember.deleted_at.is_(None))
            .order_by(OrgMember.created_at.asc())
            .limit(1)
        )
        org_member = org_member_result.scalar_one_or_none()
        if org_member:
            project_id = await first_accessible_project_id(session, user.id, org_member.org_id)
            return {
                "org_id": str(org_member.org_id),
                "project_id": str(project_id) if project_id else "",
                "role": org_member.role,
            }
        return {}

    # login 시 last_project_id 자동 갱신 — 다음 로그인부터 last_project_id 우선 경로 사용
    if getattr(user, "last_project_id", None) != member.project_id:
        user.last_project_id = member.project_id

    # S-MBR-03: org owner/admin → project role 상속 (AC1/AC2)
    # org_members.role이 team_members.role보다 높으면 org role을 effective role로 사용.
    _ROLE_RANK: dict[str, int] = {"owner": 4, "admin": 3, "manager": 2, "member": 1}
    org_roles_result = await session.execute(
        select(OrgMember.org_id, OrgMember.role).where(
            OrgMember.user_id == user.id,
            OrgMember.deleted_at.is_(None),
        )
    )
    org_role_map: dict = {str(row[0]): row[1] for row in org_roles_result.all()}

    def _effective_role(project_role: str, org_id_str: str) -> str:
        org_r = org_role_map.get(org_id_str, "")
        if _ROLE_RANK.get(org_r, 0) > _ROLE_RANK.get(project_role, 0):
            return org_r
        return project_role

    # 소속 전체 project 목록 (알림/전환 UI용)
    all_members_result = await session.execute(
        select(TeamMember)
        .where(
            or_(TeamMember.user_id == user.id, TeamMember.id == user.id),
            TeamMember.is_active.is_(True),
        )
    )
    all_members = all_members_result.scalars().all()
    projects = [
        {
            "id": str(m.project_id),
            "org_id": str(m.org_id),
            "role": _effective_role(m.role, str(m.org_id)),
        }
        for m in all_members
    ]

    return {
        "org_id": str(member.org_id),
        "project_id": str(member.project_id),
        "role": _effective_role(member.role, str(member.org_id)),
        "projects": projects,
    }


async def _store_refresh_token(
    session: AsyncSession,
    user: User,
    raw_token: str,
    expires_at: datetime,
) -> None:
    row = RefreshToken(
        user_id=user.id,
        token_hash=hash_token(raw_token),
        org_id=None,
        project_id=None,
        expires_at=expires_at,
    )
    session.add(row)
    await session.commit()


# ─── POST /api/v2/auth/register ───────────────────────────────────────────────

@router.post("/register", status_code=201)
@limiter.limit("5/minute")
async def register(
    request: Request,
    body: RegisterRequest,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    if not body.tos_accepted:
        return _err("TOS_NOT_ACCEPTED", "You must accept the Terms of Service to register", 400)

    existing = await _get_user_by_email(session, body.email)
    if existing:
        return _err("EMAIL_TAKEN", "Email already registered", 409)

    user = User(
        email=body.email,
        hashed_password=hash_password(body.password),
        display_name=body.display_name.strip() or body.email.split("@")[0],
        is_active=True,
        email_verified=False,
        tos_accepted_at=datetime.now(timezone.utc),
    )
    session.add(user)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        return _err("EMAIL_TAKEN", "Email already registered", 409)

    # AC2: invite_token 있으면 가입 후 자동 수락
    if body.invite_token:
        await _auto_accept_invitation(session, user, body.invite_token)

    tokens = create_tokens(str(user.id), email=user.email, app_metadata=await _build_app_metadata(user, session))
    _, refresh_exp = create_refresh_token(str(user.id), expires_delta=timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS))
    await _store_refresh_token(session, user, tokens["refresh_token"], refresh_exp)

    # 이메일 인증 발송 (비동기 — 실패해도 가입은 완료)
    try:
        verification_token = create_email_verification_token(str(user.id))
        app_url = os.getenv("NEXT_PUBLIC_APP_URL", "https://app.sprintable.ai")
        verify_link = f"{app_url}/verify-email?token={verification_token}"
        from app.services.email import send_email
        send_email(
            to=user.email,
            subject="Sprintable 이메일 인증",
            html_body=(
                f"<p>아래 링크를 클릭하여 이메일 인증을 완료해 주세요. 24시간 유효합니다.</p>"
                f"<p><a href='{verify_link}'>이메일 인증하기</a></p>"
            ),
        )
    except Exception:
        pass  # 이메일 발송 실패는 가입에 영향 없음

    return _ok(tokens, 201)


# ─── POST /api/v2/auth/token ──────────────────────────────────────────────────

@router.post("/token")
@limiter.limit("10/minute")
async def login(
    request: Request,
    body: LoginRequest,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    user = await _get_user_by_email(session, body.email)

    # brute force lockout 체크
    if user and user.login_locked_until:
        if user.login_locked_until > datetime.now(timezone.utc):
            remaining = int((user.login_locked_until - datetime.now(timezone.utc)).total_seconds())
            return _err("ACCOUNT_LOCKED", f"Account locked. Try again in {remaining} seconds", 429)
        # 잠금 해제 시간 경과 — 카운터 초기화
        await session.execute(
            update(User).where(User.id == user.id).values(login_fail_count=0, login_locked_until=None)
        )

    if not user or not verify_password(body.password, user.hashed_password):
        # 실패 카운터 증가
        if user:
            new_count = (user.login_fail_count or 0) + 1
            locked_until = (
                datetime.now(timezone.utc) + timedelta(minutes=5) if new_count >= 5 else None
            )
            await session.execute(
                update(User).where(User.id == user.id).values(
                    login_fail_count=new_count,
                    login_locked_until=locked_until,
                )
            )
        _ip = request.client.host if request.client else None
        _ua = request.headers.get("user-agent")
        await _write_audit(
            session, "login_failure",
            user_id=user.id if user else None,
            email=body.email,
            ip_address=_ip,
            user_agent=_ua,
            detail="INVALID_CREDENTIALS",
        )
        await session.commit()
        return _err("INVALID_CREDENTIALS", "Invalid email or password", 401)

    if user.totp_enabled:
        if not body.totp_code:
            return _err("TOTP_REQUIRED", "TOTP code required", 403)

        now = datetime.now(timezone.utc)

        # lockout 체크
        if getattr(user, "totp_locked_until", None) and user.totp_locked_until > now:
            remaining = int((user.totp_locked_until - now).total_seconds())
            return _err("TOTP_LOCKED", f"Too many failures. Retry after {remaining}s", 429)

        timestep = verify_totp_with_timestep(user.totp_secret or "", body.totp_code)

        if timestep is None:
            # 실패: 카운터 증가, 5회 도달 시 5분 lockout
            fail_count = (getattr(user, "totp_fail_count", 0) or 0) + 1
            updates: dict = {"totp_fail_count": fail_count}
            if fail_count >= 5:
                updates["totp_locked_until"] = now + timedelta(minutes=5)
                updates["totp_fail_count"] = 0
            await session.execute(update(User).where(User.id == user.id).values(**updates))
            await session.commit()
            return _err("INVALID_TOTP", "Invalid TOTP code", 403)

        # replay 체크: 같은 timestep 재사용 거부
        last_ts = getattr(user, "totp_last_timestep", None)
        if last_ts is not None and timestep <= last_ts:
            return _err("TOTP_REPLAYED", "TOTP code already used", 403)

        # 성공: 카운터 리셋 + timestep 업데이트
        await session.execute(
            update(User).where(User.id == user.id).values(
                totp_last_timestep=timestep,
                totp_fail_count=0,
                totp_locked_until=None,
            )
        )

    # 로그인 성공 — 실패 카운터 리셋
    if user.login_fail_count or user.login_locked_until:
        await session.execute(
            update(User).where(User.id == user.id).values(login_fail_count=0, login_locked_until=None)
        )

    tokens = create_tokens(str(user.id), email=user.email, app_metadata=await _build_app_metadata(user, session))
    _, refresh_exp = create_refresh_token(str(user.id), expires_delta=timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS))
    await _store_refresh_token(session, user, tokens["refresh_token"], refresh_exp)

    _ip = request.client.host if request.client else None
    _ua = request.headers.get("user-agent")
    await _write_audit(
        session, "login_success",
        user_id=user.id,
        email=user.email,
        ip_address=_ip,
        user_agent=_ua,
    )
    await session.commit()

    return _ok(tokens)


# ─── POST /api/v2/auth/refresh ────────────────────────────────────────────────

@router.post("/refresh")
@limiter.limit("20/minute")
async def refresh_token(
    request: Request,
    body: RefreshRequest,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    try:
        payload = decode_jwt(body.refresh_token)
    except JWTError:
        return _err("INVALID_TOKEN", "Invalid refresh token", 401)

    if payload.get("type") != "refresh":
        return _err("INVALID_TOKEN", "Not a refresh token", 401)

    token_hash = hash_token(body.refresh_token)
    result = await session.execute(
        select(RefreshToken).where(
            RefreshToken.token_hash == token_hash,
            RefreshToken.revoked_at.is_(None),
            RefreshToken.expires_at > datetime.now(timezone.utc),
        )
    )
    stored = result.scalar_one_or_none()
    if not stored:
        return _err("TOKEN_REVOKED", "Refresh token revoked or expired", 401)

    user_id = uuid.UUID(payload["sub"])
    user = await _get_user_by_id(session, user_id)
    if not user:
        return _err("USER_NOT_FOUND", "User not found", 401)

    # 기존 토큰 무효화 (rotation)
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.token_hash == token_hash)
        .values(revoked_at=datetime.now(timezone.utc))
    )

    tokens = create_tokens(str(user.id), email=user.email, app_metadata=await _build_app_metadata(user, session))
    _, refresh_exp = create_refresh_token(str(user.id), expires_delta=timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS))
    await _store_refresh_token(session, user, tokens["refresh_token"], refresh_exp)

    return _ok(tokens)


# ─── POST /api/v2/auth/logout ────────────────────────────────────────────────

@router.post("/logout")
async def logout(
    body: LogoutRequest,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    token_hash = hash_token(body.refresh_token)
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.token_hash == token_hash, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(timezone.utc))
    )
    await session.commit()
    return _ok({"ok": True})


# ─── POST /api/v2/auth/totp/setup ────────────────────────────────────────────

@router.post("/totp/setup")
async def totp_setup(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> JSONResponse:
    user = await _get_user_by_id(session, uuid.UUID(auth.user_id))
    if not user:
        return _err("USER_NOT_FOUND", "User not found", 404)
    if user.totp_enabled:
        return _err("TOTP_ALREADY_ENABLED", "TOTP already enabled", 409)

    secret = generate_totp_secret()
    await session.execute(
        update(User).where(User.id == user.id).values(totp_secret=secret)
    )
    await session.commit()

    uri = get_totp_provisioning_uri(secret, user.email)
    return _ok({"totp_secret": secret, "provisioning_uri": uri})


# ─── POST /api/v2/auth/totp/verify ───────────────────────────────────────────

@router.post("/totp/verify")
async def totp_verify(
    request: Request,
    body: TotpVerifyRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> JSONResponse:
    user = await _get_user_by_id(session, uuid.UUID(auth.user_id))
    if not user:
        return _err("USER_NOT_FOUND", "User not found", 404)
    if not user.totp_secret:
        return _err("TOTP_NOT_SETUP", "TOTP not initialized", 400)

    if not verify_totp(user.totp_secret, body.code):
        return _err("INVALID_TOTP", "Invalid TOTP code", 403)

    await session.execute(
        update(User).where(User.id == user.id).values(totp_enabled=True)
    )
    _ip = request.client.host if request.client else None
    _ua = request.headers.get("user-agent")
    await _write_audit(
        session, "2fa_enabled",
        user_id=user.id,
        email=user.email,
        ip_address=_ip,
        user_agent=_ua,
    )
    await session.commit()
    return _ok({"totp_enabled": True})


# ─── OAuth ────────────────────────────────────────────────────────────────────

_OAUTH_CONFIGS: dict[str, dict] = {
    "google": {
        "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth",
        "token_url": "https://oauth2.googleapis.com/token",
        "userinfo_url": "https://www.googleapis.com/oauth2/v3/userinfo",
        "scope": "openid email profile",
        "id_field": "sub",
        "email_field": "email",
    },
    "github": {
        "authorize_url": "https://github.com/login/oauth/authorize",
        "token_url": "https://github.com/login/oauth/access_token",
        "userinfo_url": "https://api.github.com/user",
        "scope": "read:user user:email",
        "id_field": "id",
        "email_field": "email",
    },
}


def _redirect_uri(provider: str) -> str:
    return f"{settings.app_url}/api/auth/callback/{provider}"


def _client_id(provider: str) -> str:
    return settings.google_client_id if provider == "google" else settings.github_client_id


def _client_secret(provider: str) -> str:
    return settings.google_client_secret if provider == "google" else settings.github_client_secret


class OAuthCallbackRequest(BaseModel):
    provider: str
    code: str
    state: str
    tos_accepted: bool = False
    invite_token: str | None = None  # AC4: OAuth 가입 시 초대 자동 수락


@router.get("/oauth/{provider}/authorize")
async def oauth_authorize(provider: str) -> JSONResponse:
    if provider not in _OAUTH_CONFIGS:
        return _err("INVALID_PROVIDER", f"Unsupported provider: {provider}", 400)
    cfg = _OAUTH_CONFIGS[provider]
    state = create_oauth_state_token(provider)
    params = {
        "client_id": _client_id(provider),
        "redirect_uri": _redirect_uri(provider),
        "response_type": "code",
        "scope": cfg["scope"],
        "state": state,
    }
    if provider == "google":
        params["access_type"] = "offline"
        params["prompt"] = "select_account"
    url = f"{cfg['authorize_url']}?{urlencode(params)}"
    return _ok({"url": url, "state": state})


@router.post("/oauth/callback")
async def oauth_callback(
    body: OAuthCallbackRequest,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    provider = body.provider
    if provider not in _OAUTH_CONFIGS:
        return _err("INVALID_PROVIDER", f"Unsupported provider: {provider}", 400)
    cfg = _OAUTH_CONFIGS[provider]

    # state JWT 검증 (CSRF 방지)
    try:
        decode_oauth_state_token(body.state, provider)
    except JWTError:
        return _err("INVALID_STATE", "OAuth state is invalid or expired", 400)

    async with httpx.AsyncClient(timeout=15) as client:
        # 1. code → access_token 교환
        token_resp = await client.post(
            cfg["token_url"],
            data={
                "client_id": _client_id(provider),
                "client_secret": _client_secret(provider),
                "code": body.code,
                "redirect_uri": _redirect_uri(provider),
                "grant_type": "authorization_code",
            },
            headers={"Accept": "application/json"},
        )
        if token_resp.status_code != 200:
            return _err("OAUTH_TOKEN_EXCHANGE_FAILED", "Failed to exchange code for token", 400)
        token_data = token_resp.json()
        access_token = token_data.get("access_token")
        if not access_token:
            return _err("OAUTH_NO_TOKEN", "No access_token in response", 400)

        # 2. userinfo 조회
        userinfo_resp = await client.get(
            cfg["userinfo_url"],
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if userinfo_resp.status_code != 200:
            return _err("OAUTH_USERINFO_FAILED", "Failed to fetch user info", 400)
        userinfo = userinfo_resp.json()

        # GitHub email이 null인 경우 /user/emails로 추가 조회
        if provider == "github" and not userinfo.get("email"):
            emails_resp = await client.get(
                "https://api.github.com/user/emails",
                headers={"Authorization": f"Bearer {access_token}"},
            )
            if emails_resp.status_code == 200:
                emails = emails_resp.json()
                primary = next((e["email"] for e in emails if e.get("primary") and e.get("verified")), None)
                if primary:
                    userinfo["email"] = primary

    oauth_id = str(userinfo.get(cfg["id_field"], ""))
    email = (userinfo.get(cfg["email_field"]) or "").lower().strip()

    if not oauth_id or not email:
        return _err("OAUTH_MISSING_INFO", "Missing id or email from provider", 400)

    # 3. 기존 유저 조회 (oauth_id 기준 → email 기준 순)
    id_col = User.google_id if provider == "google" else User.github_id
    result = await session.execute(select(User).where(id_col == oauth_id, User.is_active.is_(True)))
    user = result.scalar_one_or_none()

    if not user:
        # 동일 이메일 유저가 있으면 OAuth ID 연결
        result = await session.execute(select(User).where(User.email == email, User.is_active.is_(True)))
        user = result.scalar_one_or_none()
        if user:
            await session.execute(
                update(User).where(User.id == user.id).values(**{f"{provider}_id": oauth_id})
            )
            await session.commit()
            await session.refresh(user)
        else:
            # 신규 유저 생성 (비밀번호 없음 — OAuth 전용, 이메일 인증 완료)
            if not body.tos_accepted:
                return _err("TOS_NOT_ACCEPTED", "You must accept the Terms of Service to register", 400)
            user = User(
                email=email,
                hashed_password="",
                is_active=True,
                email_verified=True,
                tos_accepted_at=datetime.now(timezone.utc),
                **{f"{provider}_id": oauth_id},
            )
            session.add(user)
            try:
                await session.flush()
            except IntegrityError:
                await session.rollback()
                return _err("EMAIL_CONFLICT", "Email already registered", 409)

            # AC4: invite_token 있으면 신규 OAuth 유저도 자동 수락
            if body.invite_token:
                await _auto_accept_invitation(session, user, body.invite_token)

            await session.commit()
            await session.refresh(user)

    # 4. JWT 발급
    from datetime import timedelta
    from app.core.security import ACCESS_TOKEN_EXPIRE_MINUTES, REFRESH_TOKEN_EXPIRE_DAYS

    tokens = create_tokens(str(user.id), user.email, await _build_app_metadata(user, session))
    raw_refresh = tokens["refresh_token"]
    expires_at = datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    await _store_refresh_token(session, user, raw_refresh, expires_at)

    return _ok({
        "access_token": tokens["access_token"],
        "refresh_token": raw_refresh,
        "token_type": "bearer",
        "expires_in": ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    })


# ─── Password Reset ───────────────────────────────────────────────────────────

@router.post("/forgot-password")
async def forgot_password(
    body: ForgotPasswordRequest,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    user = await _get_user_by_email(session, body.email)
    # 이메일 존재 여부와 무관하게 동일 응답 (사용자 열거 방지)
    if user is not None:
        token = create_password_reset_token(str(user.id), user.hashed_password)
        app_url = os.getenv("NEXT_PUBLIC_APP_URL", "https://app.sprintable.ai")
        reset_link = f"{app_url}/reset-password?token={token}"
        from app.services.email import send_email
        send_email(
            to=user.email,
            subject="Sprintable 비밀번호 재설정",
            html_body=(
                f"<p>비밀번호 재설정 링크입니다. 30분 내에 사용 바랍니다.</p>"
                f"<p><a href='{reset_link}'>비밀번호 재설정</a></p>"
                f"<p>요청하지 않으셨다면 이 메일을 무시하세요.</p>"
            ),
        )
    return _ok({"message": "If the email exists, a reset link has been sent"})


@router.post("/reset-password")
async def reset_password(
    body: ResetPasswordRequest,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    try:
        payload = decode_password_reset_token(body.token)
    except JWTError:
        return _err("INVALID_TOKEN", "Reset token is invalid or expired", 400)

    user_id = payload.get("sub")
    pw_sig = payload.get("pw_sig", "")

    user = await _get_user_by_id(session, uuid.UUID(user_id))
    if user is None:
        return _err("USER_NOT_FOUND", "User not found", 404)

    # pw_sig 불일치 시 이미 비밀번호 변경됨 → 토큰 무효
    import hashlib as _hashlib
    if _hashlib.sha256(user.hashed_password.encode()).hexdigest()[:16] != pw_sig:
        return _err("INVALID_TOKEN", "Reset token has already been used", 400)

    await session.execute(
        update(User).where(User.id == user.id).values(hashed_password=hash_password(body.new_password))
    )
    return _ok({"message": "Password reset successfully"})


@router.patch("/change-password")
async def change_password(
    body: ChangePasswordRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> JSONResponse:
    user = await _get_user_by_id(session, uuid.UUID(auth.user_id))
    if user is None:
        return _err("USER_NOT_FOUND", "User not found", 404)

    if not verify_password(body.current_password, user.hashed_password):
        return _err("WRONG_PASSWORD", "Current password is incorrect", 400)

    await session.execute(
        update(User).where(User.id == user.id).values(hashed_password=hash_password(body.new_password))
    )
    return _ok({"message": "Password changed successfully"})


# ─── POST /api/v2/auth/set-password ──────────────────────────────────────────

@router.post("/set-password")
async def set_password(
    body: SetPasswordRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> JSONResponse:
    """OAuth 전용 사용자 최초 비밀번호 설정 (hashed_password == "" 인 경우만 허용)."""
    user = await _get_user_by_id(session, uuid.UUID(auth.user_id))
    if user is None:
        return _err("USER_NOT_FOUND", "User not found", 404)

    if user.hashed_password:
        return _err("ALREADY_HAS_PASSWORD", "User already has a password set", 400)

    await session.execute(
        update(User).where(User.id == user.id).values(hashed_password=hash_password(body.new_password))
    )
    await session.commit()
    return _ok({"message": "Password set successfully"})


# ─── Email Verification ───────────────────────────────────────────────────────

@router.get("/verify-email")
async def verify_email(
    token: str,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    try:
        payload = decode_email_verification_token(token)
    except JWTError:
        return _err("INVALID_TOKEN", "Verification link is invalid or expired", 400)

    user_id = payload.get("sub")
    user = await _get_user_by_id(session, uuid.UUID(user_id))
    if user is None:
        return _err("USER_NOT_FOUND", "User not found", 404)

    if user.email_verified:
        return _ok({"message": "Email already verified"})

    await session.execute(
        update(User).where(User.id == user.id).values(email_verified=True)
    )
    return _ok({"message": "Email verified successfully"})


@router.post("/resend-verification")
@limiter.limit("3/hour")
async def resend_verification(
    request: Request,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> JSONResponse:
    user = await _get_user_by_id(session, uuid.UUID(auth.user_id))
    if user is None:
        return _err("USER_NOT_FOUND", "User not found", 404)

    if user.email_verified:
        return _ok({"message": "Email already verified"})

    verification_token = create_email_verification_token(str(user.id))
    app_url = os.getenv("NEXT_PUBLIC_APP_URL", "https://app.sprintable.ai")
    verify_link = f"{app_url}/verify-email?token={verification_token}"
    from app.services.email import send_email
    send_email(
        to=user.email,
        subject="Sprintable 이메일 인증",
        html_body=(
            f"<p>아래 링크를 클릭하여 이메일 인증을 완료해 주세요. 24시간 유효합니다.</p>"
            f"<p><a href='{verify_link}'>이메일 인증하기</a></p>"
        ),
    )
    return _ok({"message": "Verification email sent"})


# ─── POST /api/v2/auth/switch-project ────────────────────────────────────────

class SwitchProjectRequest(BaseModel):
    project_id: uuid.UUID


@router.post("/switch-project")
async def switch_project(
    body: SwitchProjectRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> JSONResponse:
    """프로젝트 전환 — user.last_project_id 갱신 + 새 토큰 발급."""
    user = await _get_user_by_id(session, uuid.UUID(auth.user_id))
    if user is None:
        return _err("USER_NOT_FOUND", "User not found", 404)

    # 인가 체크 — team_member ∪ project_access(granted) ∪ owner/admin (me/memberships 3-branch 정합)
    if not await has_project_access(session, user.id, body.project_id):
        return _err("NOT_MEMBER", "Not an active member of this project", 403)

    # target 캡처 — _build_app_metadata가 내부 fallback으로 last_project_id를 덮어쓰므로 먼저 고정
    # (switch_org auth.py:1158-1165 동일 패턴)
    target_project_id = body.project_id
    user.last_project_id = target_project_id

    # 기존 refresh token 무효화
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(timezone.utc))
    )

    # 새 토큰 발급 — _build_app_metadata 후 project_id override (grant-only 유저 fallback 무효화)
    app_metadata = await _build_app_metadata(user, session)
    app_metadata["project_id"] = str(target_project_id)
    user.last_project_id = target_project_id  # _build_app_metadata가 덮어쓴 경우 재설정

    tokens = create_tokens(str(user.id), email=user.email, app_metadata=app_metadata)
    _, refresh_exp = create_refresh_token(str(user.id), expires_delta=timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS))
    await _store_refresh_token(session, user, tokens["refresh_token"], refresh_exp)

    await session.commit()
    return _ok(tokens)


# ─── POST /api/v2/auth/switch-org ────────────────────────────────────────────

class SwitchOrganizationRequest(BaseModel):
    org_id: uuid.UUID


@router.post("/switch-org")
async def switch_organization(
    body: SwitchOrganizationRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> JSONResponse:
    """Organization 전환 — org_members 검증 + last_project_id 갱신 + 새 토큰 발급."""
    user = await _get_user_by_id(session, uuid.UUID(auth.user_id))
    if user is None:
        return _err("USER_NOT_FOUND", "User not found", 404)

    # org_members 소속 여부 확인
    membership = await session.execute(
        select(OrgMember)
        .where(
            OrgMember.org_id == body.org_id,
            OrgMember.user_id == user.id,
            OrgMember.deleted_at.is_(None),
        )
        .limit(1)
    )
    if membership.scalar_one_or_none() is None:
        return _err("NOT_ORG_MEMBER", "Not a member of this organization", 403)

    # 대상 org의 접근 가능한 첫 project 해소 — team_member > grant > org 첫 project (grant 유저 포함)
    user.last_project_id = await first_accessible_project_id(session, user.id, body.org_id)

    # 기존 refresh token 무효화
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(timezone.utc))
    )

    # _build_app_metadata 호출 전에 target project_id 고정
    # (내부에서 user.last_project_id를 이전 org TM으로 덮어쓰므로 먼저 캡처)
    target_project_id = user.last_project_id

    # 새 토큰 발급 — switch-org 목적 자체가 org 전환이므로 target org_id + project_id 모두 덮어씀
    app_metadata = await _build_app_metadata(user, session)
    app_metadata["org_id"] = str(body.org_id)
    # 캡처해둔 target project_id로 덮어쓰기 — _build_app_metadata 내부 fallback 값 무효화
    if target_project_id:
        app_metadata["project_id"] = str(target_project_id)
    else:
        app_metadata.pop("project_id", None)

    tokens = create_tokens(str(user.id), email=user.email, app_metadata=app_metadata)
    _, refresh_exp = create_refresh_token(str(user.id), expires_delta=timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS))
    await _store_refresh_token(session, user, tokens["refresh_token"], refresh_exp)

    await session.commit()

    # E-MEMBER-SSOT AC2-2: undefined team_member 참조 제거 (8a5f260c switch500 해소).
    # project_id는 위에서 target_project_id(effective access 기반)로 이미 확정/제거됨.
    project_id = app_metadata.get("project_id")
    return _ok({**tokens, "project_id": project_id})


# ─── GET /api/v2/auth/me ─────────────────────────────────────────────────────

class AuthMeResponse(BaseModel):
    member_id: str
    org_id: str | None
    project_id: str | None


@router.get("/me", response_model=AuthMeResponse)
async def get_auth_me(
    auth: AuthContext = Depends(get_current_user),
) -> AuthMeResponse:
    """API Key Bearer 인증으로 바인딩된 member_id, org_id, project_id 반환."""
    meta = auth.claims.get("app_metadata", {})
    return AuthMeResponse(
        member_id=auth.user_id,
        org_id=auth.org_id or meta.get("org_id"),
        project_id=meta.get("project_id"),
    )
