from __future__ import annotations

import logging
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
from app.models.member import Member
from app.models.org_invite import OrgInvite
from app.models.project import OrgMember, Project
from app.models.team import TeamMember
from app.models.login_audit_log import LoginAuditLog
from app.models.user import RefreshToken, User

router = APIRouter(prefix="/api/v2/auth", tags=["auth"])
logger = logging.getLogger(__name__)


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
    """가입 시 invite_token이 있으면 해당 초대 자동 수락 + org_member 생성.

    canonical=OrgInvite(org_invites) 단일 경로. accept로 위임 → org_member 생성 +
    선택 프로젝트 project_access(granted) 부여 + status=accepted를 한 경로로 처리한다.
    (구 Invitation 테이블은 d3619e80 cutover로 제거 — #1307에서 pending 토큰 org_invites 이전 完.)
    """
    from app.repositories.org_invite import OrgInviteRepository
    await OrgInviteRepository(session).accept(invite_token, user.id, user.email)


async def _get_user_by_email(session: AsyncSession, email: str) -> User | None:
    result = await session.execute(select(User).where(User.email == email, User.is_active.is_(True)))
    return result.scalar_one_or_none()


async def _get_user_by_id(session: AsyncSession, user_id: uuid.UUID) -> User | None:
    result = await session.execute(select(User).where(User.id == user_id, User.is_active.is_(True)))
    return result.scalar_one_or_none()


_ROLE_RANK: dict[str, int] = {"owner": 4, "admin": 3, "manager": 2, "member": 1}


async def _user_projects_claim(user: User, session: AsyncSession) -> list[dict]:
    """JWT projects 클레임(전환 UI/알림용) — 사용자의 active team_member project 전량(org 무관).
    org owner/admin은 project role을 org role로 상속(effective)."""
    from app.models.team import TeamMember

    org_roles = await session.execute(
        select(OrgMember.org_id, OrgMember.role).where(
            OrgMember.user_id == user.id, OrgMember.deleted_at.is_(None),
        )
    )
    org_role_map = {str(r[0]): r[1] for r in org_roles.all()}

    def _eff(project_role: str, org_id_str: str) -> str:
        org_r = org_role_map.get(org_id_str, "")
        return org_r if _ROLE_RANK.get(org_r, 0) > _ROLE_RANK.get(project_role, 0) else project_role

    rows = await session.execute(
        select(TeamMember).where(
            or_(TeamMember.user_id == user.id, TeamMember.id == user.id),
            TeamMember.is_active.is_(True),
        )
    )
    return [
        {"id": str(m.project_id), "org_id": str(m.org_id), "role": _eff(m.role, str(m.org_id))}
        for m in rows.scalars().all()
    ]


async def _resolve_explicit_app_metadata(
    user: User, session: AsyncSession, project_id: uuid.UUID, org_id: uuid.UUID | None
) -> dict:
    """908075db 단계1: 명시 의도(접근 가능 확인된 project)로 app_metadata 해소 — 추측 없음.

    role = team_member(휴먼, 있으면 owner/admin org role 상속) > org_member role > 'member'.
    org_id는 project.org_id를 진실로(미지정/불일치 보정). side-effect(last_project_id 갱신) 없음 —
    호출부 책임(단계2 정합). has_project_access(35a0691e grant-aware)로 접근 확인된 뒤에만 호출."""
    from app.models.team import TeamMember

    proj_org = (
        await session.execute(select(Project.org_id).where(Project.id == project_id).limit(1))
    ).scalar_one_or_none()
    resolved_org = proj_org or org_id

    tm = (
        await session.execute(
            select(TeamMember).where(
                TeamMember.project_id == project_id,
                or_(TeamMember.user_id == user.id, TeamMember.id == user.id),
                TeamMember.is_active.is_(True),
            ).limit(1)
        )
    ).scalar_one_or_none()
    om_role = (
        (
            await session.execute(
                select(OrgMember.role).where(
                    OrgMember.user_id == user.id,
                    OrgMember.org_id == resolved_org,
                    OrgMember.deleted_at.is_(None),
                ).limit(1)
            )
        ).scalar_one_or_none()
        if resolved_org is not None
        else None
    )
    if tm is not None:
        # owner/admin org role 상속(effective) — _user_projects_claim _eff와 동일 기준.
        role = om_role if _ROLE_RANK.get(om_role or "", 0) > _ROLE_RANK.get(tm.role, 0) else tm.role
    else:
        role = om_role or "member"  # grant-only — org role(없으면 member)

    return {
        "org_id": str(resolved_org) if resolved_org else "",
        "project_id": str(project_id),
        "role": role,
        "projects": await _user_projects_claim(user, session),
    }


def _persist_resolved_context(user: User, md: dict) -> None:
    """908075db 단계2: flag-on 시 _build_app_metadata가 user를 mutate하지 않고 순수 해소만 하므로,
    login/refresh 호출부가 해소 결과(md)를 user.last_project_id/last_org_id에 명시 영속한다(책임 이관).

    project_id 비면(접근 가능 project 없음) last_project_id=None으로 stale 제거. org_id는 있으면만
    갱신(빈 dict {} 해소 시 last_org_id 유지). 추측 없이 deterministic 해소 결과만 영속."""
    pid = md.get("project_id") or None
    user.last_project_id = uuid.UUID(pid) if pid else None
    oid = md.get("org_id") or None
    if oid:
        user.last_org_id = uuid.UUID(oid)


async def _build_app_metadata(
    user: User, session: AsyncSession, org_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
) -> dict:
    """JWT app_metadata 구성. org_id 지정 시(switch-org 등) 프로젝트 해소를 **그 org로 스코프**해
    cross-org 옛 프로젝트 주입을 차단한다(0746 leak fix).

    org_id 미지정(refresh/login)이면 **user.last_org_id**(현재 org source-of-truth)로 스코프 —
    refresh가 org 컨텍스트가 없어 0-project org 전환 후 cross-org 옛 프로젝트를 재주입하던 leak 차단.
    last_org_id도 없으면(최초 로그인) 기존 cross-org fallback으로 home org 결정.

    project_id(switch target 등 명시 의도)는 908075db 단계1 명시존중 분기 입력 — flag on일 때만 사용."""
    from app.models.team import TeamMember

    # org_id 미지정 시 현재 org(last_org_id)로 스코프 — refresh/login이 현재 org 유지(0746 후속)
    if org_id is None:
        org_id = getattr(user, "last_org_id", None)

    # 908075db 단계1(flag-gated): 명시 의도 존중. project_id(switch target) 또는 저장된 last_project_id에
    # has_project_access(35a0691e grant-aware: team_member 휴먼 ∪ grant ∪ owner/admin) 있으면 추측 fallback
    # 타지 않고 그 project로 해소. flag off(기본)면 통째 skip → 기존 거동 100% 유지(회귀 0). grant-only
    # 명시 전환이 가장-오래된-team_member로 무효화되던 근본(2026-06-01 switch 인시던트)을 명시존중으로 해소.
    if settings.build_app_metadata_defallback:
        explicit_pid = project_id or getattr(user, "last_project_id", None)
        if explicit_pid is not None and await has_project_access(
            session, user.id, explicit_pid, org_id
        ):
            return await _resolve_explicit_app_metadata(user, session, explicit_pid, org_id)

    # 1. last_project_id 우선 → 해당 project의 active team_member (org_id 지정 시 그 org일 때만)
    member = None
    if getattr(user, "last_project_id", None):
        q = select(TeamMember).where(
            TeamMember.project_id == user.last_project_id,
            or_(TeamMember.user_id == user.id, TeamMember.id == user.id),
            TeamMember.is_active.is_(True),
        )
        if org_id is not None:
            q = q.where(TeamMember.org_id == org_id)
        member = (await session.execute(q.limit(1))).scalar_one_or_none()

    if not member and not settings.build_app_metadata_defallback:
        # fallback: 가장 오래된 team_member (ASC) — 최초 가입 project 우선.
        # ⚠️0746: org_id 지정 시 그 org로 스코프(미지정이면 org 무관 → cross-org 옛 프로젝트 누수).
        # 908075db 단계2(flag-on): 이 **추측** 제거 — flag on이면 member None 유지 → 아래 deterministic
        # 경로(first_accessible/invite/Path4)로 해소. flag off면 기존 추측 그대로(거동 무변경).
        q = select(TeamMember).where(
            or_(TeamMember.user_id == user.id, TeamMember.id == user.id),
            TeamMember.is_active.is_(True),
        )
        if org_id is not None:
            q = q.where(TeamMember.org_id == org_id)
        member = (await session.execute(q.order_by(TeamMember.created_at.asc()).limit(1))).scalar_one_or_none()

    # 0746: org_id 지정 + 그 org에 team_member 없음(grant-only/0-project/owner-admin) →
    # cross-org invite/Path4 폴백 금지. 그 org의 first_accessible(없으면 null)로 스코프 해소.
    if org_id is not None and member is None:
        pid = await first_accessible_project_id(session, user.id, org_id)
        # 908075db 단계2(flag-on): in-function last_project_id/org_id mutation 제거 → 호출부 책임
        # (_persist_resolved_context). flag off면 기존대로 영속(거동 무변경).
        if not settings.build_app_metadata_defallback:
            if getattr(user, "last_project_id", None) != pid:
                user.last_project_id = pid  # in-org project or None — cross-org 절대 금지
            if getattr(user, "last_org_id", None) != org_id:
                user.last_org_id = org_id  # 현재 org 추적 — 다음 refresh가 이 org 유지
        om_role = (
            await session.execute(
                select(OrgMember.role).where(
                    OrgMember.org_id == org_id,
                    OrgMember.user_id == user.id,
                    OrgMember.deleted_at.is_(None),
                ).limit(1)
            )
        ).scalar_one_or_none()
        return {
            "org_id": str(org_id),
            "project_id": str(pid) if pid else "",
            "role": om_role or "member",
            "projects": await _user_projects_claim(user, session),
        }

    if member and member.user_id is None:
        # AC3-5 ②: team_members가 뷰(0088) — ORM mutation+flush(UPDATE view 실패) 대신 members 앵커 UPDATE.
        # member.user_id is None은 사실상 미발현(뷰 휴먼 브랜치 user_id 채워짐); 레거시 미링크분만 보정.
        await session.execute(update(Member).where(Member.id == member.id).values(user_id=user.id))

    if not member:
        # 2. 이메일로 pending 초대 조회 → 자동 수락 + org_member 생성
        # OrgInvite (org_invites 테이블 — canonical /api/v2/invites 경로).
        # 구 Invitation(invitations) 경로는 d3619e80 cutover로 제거 — org_invites가 단일 SSOT.
        # invite link 가입 후 explicit accept 없이 로그인 시 자동 수락 fallback.
        now = datetime.now(timezone.utc)
        org_inv_result = await session.execute(
            select(OrgInvite).where(
                OrgInvite.email == user.email.lower(),
                OrgInvite.status == "pending",
                OrgInvite.expires_at > now,
            ).order_by(OrgInvite.created_at.asc()).limit(1)
        )
        org_inv = org_inv_result.scalar_one_or_none()
        if org_inv:
            # 05fa365f SSOT: 자동수락(login fallback)도 **canonical accept**로 위임 — org_member 생성 +
            # 선택 프로젝트 project_access(granted) 부여 + status=accepted를 한 경로로(명시 accept·signup과
            # 동일). 인라인 복제 제거 → 3경로(명시·signup·login-fallback) divergence 방지. (이전엔 org_member
            # +status만 하고 grant 스킵 → invitee grant 0행 → /api/projects=[].)
            from app.repositories.org_invite import OrgInviteRepository
            await OrgInviteRepository(session).accept(org_inv.token, user.id, user.email)
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

    # login 시 last_project_id 자동 갱신 — 다음 로그인부터 last_project_id 우선 경로 사용.
    # 908075db 단계2(flag-on): 이 side-effect 제거 → 호출부 책임(_persist_resolved_context). flag off
    # 면 기존대로 영속(거동 무변경). flag on에선 member가 명시 last_project_id 룩업(360-370)서만 와
    # member.project_id == last_project_id라 영속 결과는 동일(호출부가 md.project_id로 재확정).
    if not settings.build_app_metadata_defallback:
        if getattr(user, "last_project_id", None) != member.project_id:
            user.last_project_id = member.project_id
        # 현재 org 추적(0746 후속) — 다음 refresh가 org_id 없이도 이 org로 스코프
        if getattr(user, "last_org_id", None) != member.org_id:
            user.last_org_id = member.org_id

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

    _md = await _build_app_metadata(user, session)
    if settings.build_app_metadata_defallback:
        _persist_resolved_context(user, _md)  # 908075db 단계2: side-effect 호출부 이관
    tokens = create_tokens(str(user.id), email=user.email, app_metadata=_md)
    _, refresh_exp = create_refresh_token(str(user.id), expires_delta=timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS))
    await _store_refresh_token(session, user, tokens["refresh_token"], refresh_exp)

    # 이메일 인증 발송 — 실패해도 가입은 완료하되 **반드시 가시화**(silent swallow 금지).
    # send_email은 bool 반환(True=Resend/SMTP 실발송, False=콘솔 폴백=미발송). delivered를 응답
    # email_delivered로 노출(silent swallow 금지) — FE가 "201인데 인증메일 안 옴"을 감지·안내 가능
    # (bacefe2c: console-fallback 환경서 verify메일 안 와 stuck 되는 데모 signup 치명 경로 방어).
    delivered = False
    try:
        verification_token = create_email_verification_token(str(user.id))
        app_url = os.getenv("NEXT_PUBLIC_APP_URL", "https://app.sprintable.ai")
        verify_link = f"{app_url}/verify-email?token={verification_token}"
        from app.services.email import send_email
        delivered = send_email(
            to=user.email,
            subject="Sprintable 이메일 인증",
            html_body=(
                f"<p>아래 링크를 클릭하여 이메일 인증을 완료해 주세요. 24시간 유효합니다.</p>"
                f"<p><a href='{verify_link}'>이메일 인증하기</a></p>"
            ),
        )
        if not delivered:
            logger.warning(
                "register: 인증 이메일 미발송(콘솔 폴백) user_id=%s email=%s — "
                "RESEND_API_KEY/EMAIL_FROM 미설정 또는 발송 실패 추정",
                user.id, user.email,
            )
    except Exception:
        logger.exception(
            "register: 인증 이메일 발송 예외 user_id=%s email=%s (가입 자체는 완료)",
            user.id, user.email,
        )

    return _ok({**tokens, "email_delivered": delivered}, 201)


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

    _md = await _build_app_metadata(user, session)
    if settings.build_app_metadata_defallback:
        _persist_resolved_context(user, _md)  # 908075db 단계2: side-effect 호출부 이관
    tokens = create_tokens(str(user.id), email=user.email, app_metadata=_md)
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

    _md = await _build_app_metadata(user, session)
    if settings.build_app_metadata_defallback:
        _persist_resolved_context(user, _md)  # 908075db 단계2: side-effect 호출부 이관
    tokens = create_tokens(str(user.id), email=user.email, app_metadata=_md)
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

    _md = await _build_app_metadata(user, session)
    if settings.build_app_metadata_defallback:
        _persist_resolved_context(user, _md)  # 908075db 단계2: side-effect 호출부 이관
    tokens = create_tokens(str(user.id), user.email, _md)
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
    delivered = send_email(
        to=user.email,
        subject="Sprintable 이메일 인증",
        html_body=(
            f"<p>아래 링크를 클릭하여 이메일 인증을 완료해 주세요. 24시간 유효합니다.</p>"
            f"<p><a href='{verify_link}'>이메일 인증하기</a></p>"
        ),
    )
    if not delivered:
        # 콘솔 폴백(미발송)을 "sent"로 거짓 보고하지 않는다(데모 디버깅 가시화).
        logger.warning(
            "resend-verification: 인증 이메일 미발송(콘솔 폴백) user_id=%s email=%s", user.id, user.email
        )
        return _ok({"message": "Verification email could not be delivered — check email configuration", "delivered": False})
    return _ok({"message": "Verification email sent", "delivered": True})


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

    # 908075db 단계1: target을 명시 의도로 전달 — flag on이면 _build_app_metadata가 추측 없이 그대로 존중.
    app_metadata = await _build_app_metadata(user, session, project_id=target_project_id)
    # 908075db 단계3: flag-on이면 de-fallback이 명시 target 을 존중(_resolve_explicit→project_id=target)·
    # last_project_id 는 위 1229 kept + 단계2 무mutation 으로 target 유지 → 아래 override 밴드에이드가
    # redundant. flag-off(prod)만 보정(전면 삭제는 prod flag-on 後 단계4·dev 한정).
    if not settings.build_app_metadata_defallback:
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
    # 0746 후속: 현재 org 영속 → 이후 refresh(org 컨텍스트 없음)가 이 org로 스코프해 0-project org서도
    # cross-org 옛 프로젝트 재주입 0 (last_project_id=None이어도 org는 유지).
    user.last_org_id = body.org_id

    # 기존 refresh token 무효화
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(timezone.utc))
    )

    # _build_app_metadata 호출 전에 target project_id 고정
    # (내부에서 user.last_project_id를 이전 org TM으로 덮어쓰므로 먼저 캡처)
    target_project_id = user.last_project_id

    # 새 토큰 발급 — org_id 스코프로 _build_app_metadata 호출 → cross-org 옛 프로젝트 주입 차단(0746).
    # (내부가 target org로 스코프해 project_id/last_project_id를 그 org의 것 또는 null로 해소.)
    app_metadata = await _build_app_metadata(user, session, org_id=body.org_id)
    app_metadata["org_id"] = str(body.org_id)
    # 908075db 단계3: flag-on이면 org-scope de-fallback이 explicit_pid(=1283서 set한 last_project_id=
    # first_accessible)를 has_project_access로 검증해 in-org project 또는 null 로 해소(1297 capture==
    # last_project_id) → 아래 belt-and-suspenders 가 redundant. flag-off(prod)만 캡처값으로 재확정
    # (전면 삭제는 prod flag-on 後 단계4·dev 한정).
    if not settings.build_app_metadata_defallback:
        if target_project_id:
            app_metadata["project_id"] = str(target_project_id)
        else:
            app_metadata.pop("project_id", None)
        # ⚠️0746: 캡처값과 동기 보장(refresh가 cross-org로 재누수하지 않도록).
        user.last_project_id = target_project_id

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
