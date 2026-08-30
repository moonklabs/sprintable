from __future__ import annotations

import logging
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from jose import jwt as jose_jwt
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
    apple_client_secret_jwt,
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
from app.core.rate_limit import limiter, resend_verification_limiter
from app.dependencies.auth import AuthContext, get_current_user
from app.services.project_auth import (
    accessible_project_ids_in_org, first_accessible_project_id, has_project_access,
)
from app.dependencies.database import get_db
from app.models.member import Member
from app.models.org_invite import OrgInvite
from app.models.project import OrgMember, Project
from app.models.team import TeamMember
from app.models.login_audit_log import LoginAuditLog
from app.models.user import RefreshToken, User

router = APIRouter(prefix="/api/v2/auth", tags=["auth", "Organization"])
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

# story #3204(카디르 QA, PR#3612) — UTM/referrer는 유저(브라우저)가 URL 쿼리로 완전히
# 통제하는 값이라 무제한 저장 금지. 422 거부가 아니라 **클램프**(잘라서 저장) — 이상한
# UTM 값 하나로 가입 자체가 막히면(422) 신규 유저 유입 경로를 스스로 차단하는 꼴이라
# 서비스 목적에 반한다. 값 상한은 PO 확定(2026-08-29): utm 3종 각 256자, referrer는
# URL이라 더 길 수 있어 1024자.
_ATTRIBUTION_UTM_MAX_LEN = 256
_ATTRIBUTION_REFERRER_MAX_LEN = 1024


def _clamp_attribution_utm(v: str | None) -> str | None:
    return v[:_ATTRIBUTION_UTM_MAX_LEN] if v else v


def _clamp_attribution_referrer(v: str | None) -> str | None:
    return v[:_ATTRIBUTION_REFERRER_MAX_LEN] if v else v


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
    # story #3204(acquisition 계측) — proxy.ts의 first-touch 쿠키를 FE route.ts가 그대로
    # 실어 보낸다(신뢰 경계 밖 값, 자유 텍스트로만 취급 — 인가/조회 키로 안 씀).
    signup_utm_source: str | None = None
    signup_utm_medium: str | None = None
    signup_utm_campaign: str | None = None
    signup_referrer: str | None = None

    @field_validator("signup_utm_source", "signup_utm_medium", "signup_utm_campaign")
    @classmethod
    def clamp_utm(cls, v: str | None) -> str | None:
        return _clamp_attribution_utm(v)

    @field_validator("signup_referrer")
    @classmethod
    def clamp_referrer(cls, v: str | None) -> str | None:
        return _clamp_attribution_referrer(v)

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


class TotpDisableRequest(BaseModel):
    # story #3247 — 해제는 재검증 필수(AC1). 인증기 분실 시에도 끌 수 있어야 하니 두 경로
    # 중 하나(현행 TOTP 코드 또는 비밀번호)만 요구 — 상호배타 아님(둘 다 와도 code 우선
    # 검증), 둘 다 없으면 400.
    code: str | None = None
    password: str | None = None


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

async def _auto_accept_invitation(session: AsyncSession, user: User, invite_token: str) -> dict:
    """가입 시 invite_token이 있으면 해당 초대 자동 수락 + org_member 생성.

    canonical=OrgInvite(org_invites) 단일 경로. accept로 위임 → org_member 생성 +
    선택 프로젝트 project_access(granted) 부여 + status=accepted를 한 경로로 처리한다.
    (구 Invitation 테이블은 d3619e80 cutover로 제거 — #1307에서 pending 토큰 org_invites 이전 完.)

    story #3217(Referral 계측) — 반환값({"ok": bool, "org_id": str, ...})을 호출부에
    그대로 넘긴다. 기존 두 호출부(register/oauth_callback)는 이 반환값을 버렸었는데,
    이번에 "수락 성공 시에만" referral 귀속을 적용하려면 성공 여부를 알아야 한다.
    """
    from app.repositories.org_invite import OrgInviteRepository
    return await OrgInviteRepository(session).accept(invite_token, user.id, user.email)


def _apply_referral_attribution(user: User, accept_result: dict) -> None:
    """story #3217(AARRR·Referral 계측 A축·결정론 주신호) — invite_token 수락이
    **성공**했을 때만 결정론적 귀속을 쿠키 유래 signup_utm_*보다 **우선 적용**(override)
    한다. 초대 링크 자체가 유입 채널의 확정적 증거라 첫 방문 UTM/referrer 추론(story
    #3204 first-touch 쿠키)보다 신뢰도가 높다 — 그래서 "덮어쓴다"가 맞는 방향(먼저
    세팅된 쿠키 값이 있어도 이게 이긴다).

    수락 실패/토큰 무효(ok=False)면 호출 자체를 안 한다(무개입 — 기존 쿠키 경로 그대로,
    호출부에서 조건부로 호출)."""
    user.signup_utm_source = "referral"
    user.signup_utm_medium = "org_invite"
    user.signup_utm_campaign = accept_result.get("org_id")


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
) -> uuid.UUID:
    row = RefreshToken(
        user_id=user.id,
        token_hash=hash_token(raw_token),
        org_id=None,
        project_id=None,
        expires_at=expires_at,
    )
    session.add(row)
    await session.commit()
    return row.id


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

    from app.services.agent_onboarding_config import resolve_locale_from_request
    user = User(
        email=body.email,
        hashed_password=hash_password(body.password),
        password_set_at=datetime.now(timezone.utc),
        display_name=body.display_name.strip() or body.email.split("@")[0],
        is_active=True,
        email_verified=False,
        tos_accepted_at=datetime.now(timezone.utc),
        # story #3205 — 가입 시 Accept-Language 1회 포착(agents.py 등 기존 엔드포인트와
        # 동일 헬퍼 재사용, 새 파서 발명 없음). FE 명시 전달값은 없음(가입 폼에 locale
        # 필드가 없다) — 브라우저가 항상 보내는 헤더뿐이라 FE 변경 불요.
        locale=resolve_locale_from_request(None, request.headers.get("accept-language")),
        # story #3204 — 1회 포착(locale과 동형), 소급 없음.
        signup_utm_source=body.signup_utm_source,
        signup_utm_medium=body.signup_utm_medium,
        signup_utm_campaign=body.signup_utm_campaign,
        signup_referrer=body.signup_referrer,
    )
    session.add(user)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        return _err("EMAIL_TAKEN", "Email already registered", 409)

    # AC2: invite_token 있으면 가입 후 자동 수락
    if body.invite_token:
        accept_result = await _auto_accept_invitation(session, user, body.invite_token)
        if accept_result.get("ok"):
            _apply_referral_attribution(user, accept_result)

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
        from app.services.agent_onboarding_config import resolve_locale
        from app.services.email import render_action_email, send_email
        from app.services.email_copy import TRANSACTIONAL_COPY
        # story #3205 — locale=ko 유저 → ko 메일·locale=en 유저 → en 메일(AC1).
        locale = resolve_locale(user.locale)
        copy = TRANSACTIONAL_COPY["verify_email"][locale]
        delivered = send_email(
            to=user.email,
            subject=copy["subject"],
            html_body=render_action_email(
                intro_lines=copy["intro_lines"],
                cta_label=copy["cta_label"],
                cta_url=verify_link,
                expiry_note=copy["expiry_note"],
                security_note=copy["security_note"],
                locale=locale,
                fallback_label=copy["fallback_label"],
            ),
        )
        if not delivered:
            # SPR-13: provider 미설정 설치에서 운영자가 로그로 인증을 완료할 수 있게 링크를 남긴다
            # (자기 인스턴스 로그 = 운영자 신뢰 경계 안. 실발송 성공 시에는 안 찍힘).
            logger.warning(
                "register: 인증 이메일 미발송(콘솔 폴백) user_id=%s email=%s — "
                "RESEND_API_KEY/EMAIL_FROM 미설정 또는 발송 실패 추정. 인증 링크: %s",
                user.id, user.email, verify_link,
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
        logger.warning("auth.refresh 실패 reason=invalid_jwt")
        return _err("INVALID_TOKEN", "Invalid refresh token", 401)

    if payload.get("type") != "refresh":
        logger.warning("auth.refresh 실패 reason=not_refresh_type sub=%s", payload.get("sub"))
        return _err("INVALID_TOKEN", "Not a refresh token", 401)

    token_hash = hash_token(body.refresh_token)
    correlation_key = token_hash[:12]  # story e5225c0a: 산티아고 관측성 요구 — 로그 상관키(PII 아님)

    # ⚠️story e5225c0a(P0): switch_account(위)와 동형의 원자 rotation. 기존 SELECT→별도 UPDATE는
    # 비원자라 Cloud Run 멀티 인스턴스 간 동시 refresh가 둘 다 "아직 안 revoke"로 통과하는 race의
    # 근본 원인이었다(산티아고 prod 로그 실측: /auth/refresh 239건 중 230건 401). 검증+revoke를
    # 단일 UPDATE...WHERE revoked_at IS NULL...RETURNING으로 묶어 동시 요청 중 정확히 1건만 매치.
    #
    # ⛔story #2449 회귀(카디르 QA REQUEST_CHANGES, 2026-08-04): 이 원자 UPDATE에 replaced_by=
    # <미리 생성한 새 id>를 «같은» 문장으로 얹었던 1차 구현은, revoke 직후 user 조회가 실패
    # (예: 그새 계정 비활성화)해 새 row INSERT 前에 401로 조기 반환하면 — deferred FK가 커밋
    # 시점에 "그 id를 가진 row가 없다"로 위반돼 «트랜잭션 전체»(이 revoke 포함)가 롤백됐다.
    # 즉 진짜 승자의 원자 revoke 자체가 무효화되어 같은 RT가 재사용 가능한 상태로 되돌아가는
    # — e5225c0a P0가 막으려던 바로 그 single-use 불변식 파손을 재도입하는 회귀였다. 감사기록
    # (replaced_by)의 성패가 anti-replay 불변식의 성패에 영향을 줘선 안 된다 — 그래서 이 revoke
    # UPDATE는 replaced_by 없이 «독립적으로» 커밋되고, replaced_by는 새 row가 실제로 INSERT+
    # commit된 «후에» 별개 문장으로 기록한다(아래 _store_refresh_token 호출부 이후).
    revoked_user_id = (await session.execute(
        update(RefreshToken)
        .where(
            RefreshToken.token_hash == token_hash,
            RefreshToken.revoked_at.is_(None),
            RefreshToken.expires_at > datetime.now(timezone.utc),
        )
        .values(revoked_at=datetime.now(timezone.utc))
        .returning(RefreshToken.user_id)
    )).scalar_one_or_none()
    won_atomic_rotation = revoked_user_id is not None
    if revoked_user_id is None:
        # ⛔P0 신 클래스(#1887 쿠키-Domain no-op과 별개) — proxy.ts 의 FE 인스턴스-로컬
        # single-flight dedupe 는 Cloud Run 멀티인스턴스 간 공유가 안 돼, 하드리프레시의 병렬
        # 인증요청이 인스턴스 분산되면 같은 RT 로 동시 rotate 경합이 남는다 — 진 쪽은 방금(창
        # 내) 이미 소비된 RT 를 만난 것뿐, 진짜 stale/탈취 replay 가 아니다.
        #
        # story #2449 설계 확定(2026-08-04, 디디 분석·PO 승인): 처음엔 replaced_by 체인을
        # 끝까지 walk 해 "아직 아무도 안 쓴 살아있는 successor"까지 수렴시키는 안을 검토했으나,
        # (a) 그 walk 깊이는 판정 결과에 영향이 없다 — 제시된 old RT «자신»의 revoked_at 하나만
        # 이 창과 비교해도 몇 세대 뒤든 결론이 같다. (b) 오히려 그 살아있는 successor 는 아직
        # 자기 소유자(그 rotation 을 실제로 받은 탭)가 한 번도 안 쓴 토큰이라, straggler 가
        # 먼저 소비(walk-and-fork)해버리면 정당한 소유자가 나중에(다음 access-token 만료 시,
        # 최대 60분 뒤) 그 토큰을 처음 쓸 때 되레 하드 401 — 문제를 근절이 아니라 한 세대
        # 뒤로 떠넘기는 꼴이었다. (c) raw RT 는 hash-only 보관이라 애초에 "현재 살아있는 tip
        # 의 실제 값"을 straggler 에게 돌려줄 방법도 없다. 그래서 설계는 「창 넓히기(grace_
        # seconds→chain_resolve_window_seconds) + 통과 시 오늘과 동일한 독립 fork(다른 row
        # 무접촉)」로 수렴했다 — replaced_by 는 «승자 경로에서만» 기록해 감사열(정상 회전 死
        # vs logout 같은 명시적 dead-end 구분)·향후 family-revoke 훅 기반으로만 쓴다.
        resolve_cutoff = datetime.now(timezone.utc) - timedelta(
            seconds=settings.auth_refresh_chain_resolve_window_seconds
        )
        revoked_user_id = (await session.execute(
            select(RefreshToken.user_id).where(
                RefreshToken.token_hash == token_hash,
                RefreshToken.revoked_at.is_not(None),
                RefreshToken.revoked_at > resolve_cutoff,
                RefreshToken.expires_at > datetime.now(timezone.utc),
            )
        )).scalar_one_or_none()
        if revoked_user_id is None:
            # #2124(관측성 보강 — 오르테가군 요청 2026-07-27): 하드 401은 지금까지 계정 상관이
            # 0이라 "누가 이 루프에 빠졌는지" 못 쫓았다(prod 실측: 같은 key가 ~20초 간격으로
            # 수십 회 반복 — "가끔 풀린다"가 아니라 "빠지면 못 나온다"). row 자체(만료/폐기든)가
            # 있으면 user_id를 읽기만(best-effort, 인가 판정에 영향 0 — 이미 위에서 거부 확定
            # 後의 순수 로깅 조회) 해 로그에 싣는다. 새 규칙 발명 0 — window_reuse가 이미
            # 로깅하는 user_id 축을 실패 로그에도 동일하게 확장하는 것뿐.
            _diag_user_id = (await session.execute(
                select(RefreshToken.user_id).where(RefreshToken.token_hash == token_hash)
            )).scalar_one_or_none()
            logger.warning(
                "auth.refresh 실패 reason=token_not_found_or_revoked_or_expired key=%s user_id=%s",
                correlation_key, _diag_user_id,
            )
            return _err("TOKEN_REVOKED", "Refresh token revoked or expired", 401)
        logger.info(
            "auth.refresh chain_resolve_window_reuse key=%s user_id=%s "
            "reason=multi_instance_race_loser_fork_rotation",
            correlation_key, revoked_user_id,
        )

    user = await _get_user_by_id(session, revoked_user_id)
    if not user:
        logger.warning(
            "auth.refresh 실패 reason=user_not_found key=%s user_id=%s", correlation_key, revoked_user_id,
        )
        return _err("USER_NOT_FOUND", "User not found", 401)

    _md = await _build_app_metadata(user, session)
    if settings.build_app_metadata_defallback:
        _persist_resolved_context(user, _md)  # 908075db 단계2: side-effect 호출부 이관
    tokens = create_tokens(str(user.id), email=user.email, app_metadata=_md)
    _, refresh_exp = create_refresh_token(str(user.id), expires_delta=timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS))
    new_token_id = await _store_refresh_token(session, user, tokens["refresh_token"], refresh_exp)
    if won_atomic_rotation:
        # story #2449(회귀 수정): 이 시점엔 새 row가 이미 INSERT+commit 완료라(_store_refresh_
        # token 내부), old row의 이 UPDATE가 실패하거나 프로세스가 죽어도 원자 revoke(위)는
        # 이미 별개로 확定돼 있어 anti-replay 불변식과 무관 — 순수 감사기록일 뿐이다.
        await session.execute(
            update(RefreshToken)
            .where(RefreshToken.token_hash == token_hash)
            .values(replaced_by=new_token_id)
        )
        await session.commit()
    # #2124(관측성 보강): 성공 회전도 old_key→new_key로 로깅 — 지금까지 성공 경로엔 로그가
    # 아예 없어(까심발견류 '침묵이 결함을 오래 살린다'와 동형) "회전은 성공했는데 클라가 새
    # 토큰을 저장 못 했는가(㉮)"를 훗날 old_key의 하드 401과 new_key의 미사용 여부로 대조
    # 가능하게 한다. ⛔이 로그만으론 ㉮/㉯/㉰을 이 순간 즉시 못 가른다 — 다음 요청과의 대조가
    # 필요(추가 조사 축이지 이 changeset의 판정은 아님).
    new_correlation_key = hash_token(tokens["refresh_token"])[:12]
    logger.info(
        "auth.refresh rotated old_key=%s new_key=%s user_id=%s", correlation_key, new_correlation_key, user.id,
    )

    return _ok(tokens)


# ─── POST /api/v2/auth/switch-account ─────────────────────────────────────────

@router.post("/switch-account")
@limiter.limit("20/minute")
async def switch_account(
    request: Request,
    body: RefreshRequest,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """멀티계정 switcher — vault 의 target refresh token 으로 active 세션 전환(rotation).

    refresh 와 동형(타겟 RT 검증→rotate→신규 tokens)이되, FE 가 활성화할 project_id 를 동봉한다
    (라이브 회귀: BE 미구현 404 → switch 무동작). single-use RT rotation 으로 이중소비 방지.
    """
    try:
        payload = decode_jwt(body.refresh_token)
    except JWTError:
        return _err("INVALID_TOKEN", "Invalid refresh token", 401)

    if payload.get("type") != "refresh":
        return _err("INVALID_TOKEN", "Not a refresh token", 401)

    token_hash = hash_token(body.refresh_token)
    # ⚠️ 원자 single-use rotation(까심 TOCTOU): SELECT-then-UPDATE 비원자면 동시 2요청이 둘 다
    # 통과해 double-spend. 검증+revoke 를 단일 UPDATE...WHERE revoked_at IS NULL...RETURNING 으로
    # 원자화 — 동시 요청 중 정확히 1건만 row 매치(나머지 0행→401).
    revoked_user_id = (await session.execute(
        update(RefreshToken)
        .where(
            RefreshToken.token_hash == token_hash,
            RefreshToken.revoked_at.is_(None),
            RefreshToken.expires_at > datetime.now(timezone.utc),
        )
        .values(revoked_at=datetime.now(timezone.utc))
        .returning(RefreshToken.user_id)
    )).scalar_one_or_none()
    if revoked_user_id is None:
        return _err("TOKEN_REVOKED", "Refresh token revoked or expired", 401)

    user = await _get_user_by_id(session, revoked_user_id)
    if not user:
        return _err("USER_NOT_FOUND", "User not found", 401)

    _md = await _build_app_metadata(user, session)
    if settings.build_app_metadata_defallback:
        _persist_resolved_context(user, _md)  # last_project_id/last_org_id 영속
    tokens = create_tokens(str(user.id), email=user.email, app_metadata=_md)
    _, refresh_exp = create_refresh_token(str(user.id), expires_delta=timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS))
    await _store_refresh_token(session, user, tokens["refresh_token"], refresh_exp)

    return _ok({
        **tokens,
        "project_id": str(user.last_project_id) if user.last_project_id else None,
    })


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


# ─── POST /api/v2/auth/totp/disable ──────────────────────────────────────────
# story #3247 — 인벤토리(#3246) 발견 A: FE `/api/v2/auth/2fa/disable`가 이 라우트 부재로
# 항상 404였다(2fa≠totp 네이밍도 불일치·별도 문제). 이 엔드포인트로 네이밍을 totp 축에
# 통일(setup/verify와 동형) — FE도 같이 정정한다(PR 본문에 명기).

@router.post("/totp/disable")
async def totp_disable(
    body: TotpDisableRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> JSONResponse:
    user = await _get_user_by_id(session, uuid.UUID(auth.user_id))
    if not user:
        return _err("USER_NOT_FOUND", "User not found", 404)
    if not user.totp_enabled:
        return _err("TOTP_NOT_ENABLED", "TOTP is not enabled", 400)

    if body.code:
        if not verify_totp(user.totp_secret or "", body.code):
            return _err("INVALID_TOTP", "Invalid TOTP code", 403)
    elif body.password:
        # 카디르+codex QA 지적(PR#3634) — 우회체인 실증: OAuth 전용 계정(비밀번호 없음)의
        # 탈취 세션/API키로 ①set-password(재인증 0, 별건 ab2a503f)로 방금 비밀번호를 심고
        # → ②그 비밀번호를 여기 제출 → ③서버가 정상 재검증으로 인정해 2FA 해제. 독립
        # 자격증명 0으로 뚫린다. 처방(PO 방향 A) 최소방어선 2단:
        #
        # ① API키(sk_live_/hu_live_) 경로는 password 분기 자체를 불허 — 두 API키 경로
        # 모두 claims에 iat이 안 실린다(_resolve_api_key/_resolve_human_api_key,
        # dependencies/auth.py) 그래서 "얼마나 오래된 비밀번호인가"를 판별할 수단이 없다.
        if "iat" not in auth.claims:
            return _err("PASSWORD_REVERIFICATION_REQUIRES_SESSION", "Password re-verification requires a browser session, not an API key", 403)

        # PO QA 지적(PR#3634) — OAuth 가입 유저는 hashed_password=""(register()의 OAuth
        # 분기, set-password가 그 의미를 문서화)라 verify_password(pw, "")를 그대로
        # 타면 passlib이 빈 해시를 식별 못 해 UnknownHashError(→500, AC1의 "서버 명시
        # 거부"가 아님)로 샌다 — 비밀번호 자체가 없는 계정은 명시 403으로 먼저 거른다.
        if not user.hashed_password:
            return _err("PASSWORD_NOT_SET", "This account has no password set", 403)
        if not verify_password(body.password, user.hashed_password):
            return _err("WRONG_PASSWORD", "Incorrect password", 403)

        # ② JWT 경로 — 그 비밀번호가 "지금 세션(토큰 발급 시각)보다 먼저" 존재했을 때만
        # 유효한 재검증으로 인정. password_set_at이 토큰 iat 이후면(=이 세션 안에서 방금
        # 심은 비밀번호) 우회체인 그 자체이므로 거부. password_set_at IS NULL(migration
        # 0295 이전부터 비밀번호를 가진 기존 유저)은 제약 대상 밖(0290 locale과 동형 논지
        # — 과거 시점을 알 방법이 없어 백필은 거짓 신호, 무제약 유지=무회귀).
        if user.password_set_at is not None:
            token_iat = auth.claims.get("iat")
            if not isinstance(token_iat, int) or user.password_set_at.timestamp() > token_iat:
                return _err("PASSWORD_TOO_RECENT", "Password was set after this session started — please log in again", 403)
    else:
        return _err("REVERIFICATION_REQUIRED", "TOTP code or password required", 400)

    await session.execute(
        update(User).where(User.id == user.id).values(
            totp_enabled=False, totp_secret=None,
        )
    )
    await _write_audit(
        session, "2fa_disabled",
        user_id=user.id,
        email=user.email,
    )
    await session.commit()
    return _ok({"totp_enabled": False})


# ─── OAuth ────────────────────────────────────────────────────────────────────

# story #2155(2026-07-23, 선생님 지시): GitHub 로그인 제거 — 첫 화면 로그인 버튼이
# "개발자 도구" 포지셔닝을 말하지 않게 하기 위함(GitHub App/봇 연동 `github_app.py`는
# 완전히 별개 물건이라 무관 — config.py:209 주석 참조). 제거 전 prod 실측(디디, 읽기전용
# 1회 잡): github_id는 있으나 다른 로그인 수단이 없는 사용자 0명 — 이관 경로 불요.
#
# story #3118(Sign in with Apple, App Store Guideline 4.8) — "google 하나뿐"이던 전제가
# 깨져 아래 provider 분기가 실제로 쓰인다. Apple은 Google과 프로토콜 모양이 다르다:
# userinfo GET 엔드포인트가 없고(id_token JWT 안에 sub/email이 실려온다, JWKS로 서명 검증),
# client_secret도 고정 문자열이 아니라 매 요청 서명하는 JWT다(_client_secret() 참고). 그래서
# "userinfo_url" 대신 "jwks_url"을 두고, oauth_callback()의 2번 단계(userinfo 조회)가
# provider별로 완전히 다른 코드 경로를 탄다(아래 참고).
_OAUTH_CONFIGS: dict[str, dict] = {
    "google": {
        "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth",
        "token_url": "https://oauth2.googleapis.com/token",
        "userinfo_url": "https://www.googleapis.com/oauth2/v3/userinfo",
        "scope": "openid email profile",
        "id_field": "sub",
        "email_field": "email",
    },
    "apple": {
        "authorize_url": "https://appleid.apple.com/auth/authorize",
        "token_url": "https://appleid.apple.com/auth/token",
        "jwks_url": "https://appleid.apple.com/auth/keys",
        "scope": "name email",
        "id_field": "sub",
        "email_field": "email",
    },
}


def _redirect_uri(provider: str) -> str:
    return f"{settings.app_url}/api/auth/callback/{provider}"


def _client_id(provider: str) -> str:
    if provider == "apple":
        return settings.apple_services_id
    return settings.google_client_id


def _client_secret(provider: str) -> str:
    if provider == "apple":
        return apple_client_secret_jwt(
            team_id=settings.apple_team_id,
            services_id=settings.apple_services_id,
            key_id=settings.apple_key_id,
            private_key_pem=settings.apple_private_key,
        )
    return settings.google_client_secret


async def _verify_apple_id_token(client: httpx.AsyncClient, id_token: str, *, expected_audience: str) -> dict:
    """Apple id_token(JWT)을 JWKS로 서명 검증하고 클레임을 반환한다.

    story #3118 — Apple은 userinfo 엔드포인트가 없어 이 토큰의 sub/email 클레임이 유일한
    신원 출처다. 서명 검증 없이 디코드만 하면 위조 토큰을 그대로 신뢰하는 구멍이 생기므로,
    매 호출마다 Apple의 공개 JWKS(https://appleid.apple.com/auth/keys)를 받아 헤더의 kid에
    맞는 키만 골라 RS256으로 검증한다(캐싱 안 함 — 로그인은 고빈도 경로가 아니고, Apple이
    키를 순환해도 캐시 미스로 인한 로그인 실패를 만들지 않는 쪽이 더 안전하다).
    """
    unverified_header = jose_jwt.get_unverified_header(id_token)
    kid = unverified_header.get("kid")
    if not kid:
        raise JWTError("Apple id_token missing kid header")

    jwks_resp = await client.get(_OAUTH_CONFIGS["apple"]["jwks_url"])
    if jwks_resp.status_code != 200:
        raise JWTError("Failed to fetch Apple JWKS")
    matching_key = next((k for k in jwks_resp.json().get("keys", []) if k.get("kid") == kid), None)
    if not matching_key:
        raise JWTError("No matching Apple JWKS key for id_token kid")

    return jose_jwt.decode(
        id_token,
        matching_key,
        algorithms=["RS256"],
        audience=expected_audience,
        issuer="https://appleid.apple.com",
    )


class OAuthExchangeError(Exception):
    """code→token/userinfo 교환 실패. .code/.message가 그대로 _err() 응답에 매핑된다.

    story #3122 — 로그인 콜백(oauth_callback)과 계정연결 콜백(oauth_link_callback)이
    같은 프로토콜 단계(code→token→userinfo, Apple이면 JWKS 서명검증까지)를 공유한다.
    Apple id_token 검증 같은 보안 로직을 두 곳에 복붙해두면 한쪽만 고치고 잊는 사고가
    나기 쉬워 단일 헬퍼(_exchange_oauth_code_for_userinfo)로 추출했다."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


async def _exchange_oauth_code_for_userinfo(
    client: httpx.AsyncClient, provider: str, cfg: dict, code: str,
) -> tuple[str, str]:
    """code→access_token 교환 후 (oauth_id, email) 반환. email은 provider가 안 주면 ""(빈
    문자열) — Apple은 최초 인가 이후 재인가에서 email을 아예 안 돌려주는 게 공식 동작이라
    "필수 여부" 판단은 호출부 책임으로 남긴다(oauth_callback은 신규가입에 이메일이 필수라
    직접 검사하고, oauth_link_callback은 oauth_id만 있으면 충분 — 이메일로 아무것도 안 함)."""
    token_resp = await client.post(
        cfg["token_url"],
        data={
            "client_id": _client_id(provider),
            "client_secret": _client_secret(provider),
            "code": code,
            "redirect_uri": _redirect_uri(provider),
            "grant_type": "authorization_code",
        },
        headers={"Accept": "application/json"},
    )
    if token_resp.status_code != 200:
        raise OAuthExchangeError("OAUTH_TOKEN_EXCHANGE_FAILED", "Failed to exchange code for token")
    token_data = token_resp.json()
    access_token = token_data.get("access_token")
    if not access_token:
        raise OAuthExchangeError("OAUTH_NO_TOKEN", "No access_token in response")

    if provider == "apple":
        id_token = token_data.get("id_token")
        if not id_token:
            raise OAuthExchangeError("OAUTH_NO_TOKEN", "No id_token in response")
        try:
            userinfo = await _verify_apple_id_token(client, id_token, expected_audience=_client_id(provider))
        except JWTError:
            raise OAuthExchangeError("OAUTH_USERINFO_FAILED", "Failed to verify Apple id_token")
    else:
        userinfo_resp = await client.get(
            cfg["userinfo_url"],
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if userinfo_resp.status_code != 200:
            raise OAuthExchangeError("OAUTH_USERINFO_FAILED", "Failed to fetch user info")
        userinfo = userinfo_resp.json()

    oauth_id = str(userinfo.get(cfg["id_field"], ""))
    email = (userinfo.get(cfg["email_field"]) or "").lower().strip()
    return oauth_id, email


class OAuthCallbackRequest(BaseModel):
    provider: str
    code: str
    state: str
    tos_accepted: bool = False
    invite_token: str | None = None  # AC4: OAuth 가입 시 초대 자동 수락
    # story #3204 — register()와 동일 계약(신뢰 경계 밖 자유 텍스트, 신규 유저 생성
    # 분기에서만 사용 — 기존 유저 매칭/링크 분기는 무시한다, 재가입이 아니므로).
    signup_utm_source: str | None = None
    signup_utm_medium: str | None = None
    signup_utm_campaign: str | None = None
    signup_referrer: str | None = None

    @field_validator("signup_utm_source", "signup_utm_medium", "signup_utm_campaign")
    @classmethod
    def clamp_utm(cls, v: str | None) -> str | None:
        return _clamp_attribution_utm(v)

    @field_validator("signup_referrer")
    @classmethod
    def clamp_referrer(cls, v: str | None) -> str | None:
        return _clamp_attribution_referrer(v)


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
    if provider == "apple":
        # Apple 공식 요건 — scope에 name/email이 있으면 GET 리다이렉트가 아니라 콜백 URL로
        # POST(form_post)해야 한다(Apple 스펙, GET이면 invalid_request). FE 콜백 라우트
        # (apps/web/src/app/api/auth/callback/[provider]/route.ts)가 이 provider에 한해
        # POST 바디도 받아야 한다 — story #3118 FE 변경분 참고.
        params["response_mode"] = "form_post"
    url = f"{cfg['authorize_url']}?{urlencode(params)}"
    return _ok({"url": url, "state": state})


@router.post("/oauth/callback")
async def oauth_callback(
    request: Request,
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
        try:
            oauth_id, email = await _exchange_oauth_code_for_userinfo(client, provider, cfg, body.code)
        except OAuthExchangeError as exc:
            return _err(exc.code, exc.message, 400)

    if not oauth_id or not email:
        return _err("OAUTH_MISSING_INFO", "Missing id or email from provider", 400)

    # 3. 기존 유저 조회 (oauth_id 기준 → email 기준 순)
    # story #3118 — "google 하나뿐"이던 시절의 하드코딩(User.google_id 고정)을 provider-
    # generic으로 연다. User 모델에 {provider}_id 컬럼이 없으면(등록 안 된 provider) 여기
    # AttributeError로 바로 터지는 게 맞다 — _OAUTH_CONFIGS에 provider가 있는데 컬럼이
    # 없는 상태는 배포 순서 실수(마이그레이션 누락)지 조용히 넘길 상황이 아니다.
    id_col = getattr(User, f"{provider}_id")
    result = await session.execute(select(User).where(id_col == oauth_id, User.is_active.is_(True)))
    user = result.scalar_one_or_none()
    # story #3204 — sign_up 전환 이벤트 발화 신호. "신규 유저 생성" 분기(아래)에서만
    # true — 기존 유저를 provider_id/email로 찾아 링크만 한 경우는 로그인이지 가입이
    # 아니다(재가입 아님).
    is_new_user = False

    if not user:
        # story #3118(PO 확定 2026-08-26, private relay 이메일 특성) — Apple은 이메일 자동
        # 매칭 병합을 안 탄다. Apple의 "이메일 가리기" 기능 때문에 같은 사람이 Google=실
        # 이메일·Apple=매 앱마다 다른 relay 이메일을 쓸 수 있어, 이메일 매칭이 오히려
        # 엉뚱한 계정에 잘못 연결될 위험이 더 크다(A의 relay 이메일이 우연히 B의 실이메일과
        # 같을 순 없지만, 반대로 "당연히 매칭돼야 할 계정"이 매칭 안 되는 게 기본이 되므로
        # 자동 병합에 기대지 않는다 — Apple의 sub만이 신뢰 가능한 1차 키). 수동 "계정 연결"
        # UI는 별도 후속 스토리(PO 등재 예정) — 여기서는 항상 신규 생성한다.
        user = None if provider == "apple" else (
            await session.execute(select(User).where(User.email == email, User.is_active.is_(True)))
        ).scalar_one_or_none()
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
            from app.services.agent_onboarding_config import resolve_locale_from_request
            user = User(
                email=email,
                hashed_password="",
                is_active=True,
                email_verified=True,
                tos_accepted_at=datetime.now(timezone.utc),
                # story #3205 — register()와 동일 포착(발명 0).
                locale=resolve_locale_from_request(None, request.headers.get("accept-language")),
                # story #3204 — register()와 동일 포착(발명 0).
                signup_utm_source=body.signup_utm_source,
                signup_utm_medium=body.signup_utm_medium,
                signup_utm_campaign=body.signup_utm_campaign,
                signup_referrer=body.signup_referrer,
                **{f"{provider}_id": oauth_id},
            )
            session.add(user)
            try:
                await session.flush()
            except IntegrityError:
                await session.rollback()
                return _err("EMAIL_CONFLICT", "Email already registered", 409)
            is_new_user = True

            # AC4: invite_token 있으면 신규 OAuth 유저도 자동 수락
            if body.invite_token:
                accept_result = await _auto_accept_invitation(session, user, body.invite_token)
                if accept_result.get("ok"):
                    _apply_referral_attribution(user, accept_result)

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
        # story #3204 — FE route.ts가 이 값으로 목적지 URL에 sign_up 이벤트 발화 신호를
        # 붙인다(?signup=1). 본인 인증 응답 안이라 계정 존재 여부를 타인에게 누출하지
        # 않는다(PO 확認 2026-08-29).
        "is_new_user": is_new_user,
    })


# ─── OAuth Account Linking (story #3122) ──────────────────────────────────────
# #3118(Sign in with Apple) 그라운딩: Apple private relay 이메일이면 자동 이메일 병합이
# 원천 불가해(oauth_callback 위 주석 참고) 항상 신규 계정이 생긴다 — PO 확定 정책은
# "자동 병합에 안 기댄다, 병합은 사용자 주도 수동 연결로"였다. 이 3개 엔드포인트가 그
# link rail: authorize(로그인 rail과 별개 — 이미 로그인된 유저 전용)·callback(신규 JWT를
# 안 민팅한다 — 기존 세션에 provider_id만 붙인다)·unlink(최소 1개 로그인 수단 보장).

@router.get("/oauth/{provider}/link/authorize")
async def oauth_link_authorize(
    provider: str,
    auth: AuthContext = Depends(get_current_user),
) -> JSONResponse:
    if provider not in _OAUTH_CONFIGS:
        return _err("INVALID_PROVIDER", f"Unsupported provider: {provider}", 400)
    cfg = _OAUTH_CONFIGS[provider]
    # redirect_uri는 로그인 rail과 완전히 동일한 물리 경로(_redirect_uri) — Google/Apple
    # 콘솔에 등록된 콜백 도메인을 이 스토리 때문에 새로 추가할 필요가 없다. link 여부는
    # state의 link_user_id 클레임과 FE의 별도 oauth_link_{provider} 쿠키(BFF route)로만
    # 갈린다 — provider 쪽에서 보면 로그인 요청과 구분되지 않는다(의도된 설계).
    state = create_oauth_state_token(provider, link_user_id=auth.user_id)
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
    if provider == "apple":
        params["response_mode"] = "form_post"
    url = f"{cfg['authorize_url']}?{urlencode(params)}"
    return _ok({"url": url, "state": state})


class OAuthLinkCallbackRequest(BaseModel):
    provider: str
    code: str
    state: str


@router.post("/oauth/{provider}/link/callback")
async def oauth_link_callback(
    provider: str,
    body: OAuthLinkCallbackRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> JSONResponse:
    if provider not in _OAUTH_CONFIGS or provider != body.provider:
        return _err("INVALID_PROVIDER", f"Unsupported provider: {provider}", 400)
    cfg = _OAUTH_CONFIGS[provider]

    try:
        state_payload = decode_oauth_state_token(body.state, provider)
    except JWTError:
        return _err("INVALID_STATE", "OAuth state is invalid or expired", 400)

    # 방어: state 발급 시점 유저 ≠ 콜백 시점 유저(10분 창 안에 로그아웃/계정전환) — 엉뚱한
    # 계정에 연결되는 걸 막는다. authorize 자체가 auth 필수라 link_user_id는 항상 있다.
    if state_payload.get("link_user_id") != auth.user_id:
        return _err("LINK_SESSION_MISMATCH", "Your session changed during linking — please try again", 409)

    async with httpx.AsyncClient(timeout=15) as client:
        try:
            oauth_id, _email = await _exchange_oauth_code_for_userinfo(client, provider, cfg, body.code)
        except OAuthExchangeError as exc:
            return _err(exc.code, exc.message, 400)

    if not oauth_id:
        return _err("OAUTH_MISSING_INFO", "Missing id from provider", 400)

    id_col = getattr(User, f"{provider}_id")
    existing = (await session.execute(
        select(User).where(id_col == oauth_id, User.is_active.is_(True))
    )).scalar_one_or_none()

    current_user_id = uuid.UUID(auth.user_id)
    if existing and existing.id != current_user_id:
        # AC2 — 이미 다른 계정에 묶인 provider_id. 병합이 아니라 명시 거부(계정 탈취 방지).
        await _write_audit(
            session, "oauth_link_rejected_conflict", user_id=current_user_id,
            detail=f"provider={provider} already_linked_to={existing.id}",
            ip_address=request.client.host if request.client else None,
        )
        await session.commit()
        return _err("PROVIDER_ALREADY_LINKED", f"This {provider} account is already linked to a different account", 409)

    if existing and existing.id == current_user_id:
        return _ok({"provider": provider, "linked": True})  # 멱등 — 이미 본인 계정에 연결됨

    await session.execute(
        update(User).where(User.id == current_user_id).values(**{f"{provider}_id": oauth_id})
    )
    await _write_audit(
        session, "oauth_link", user_id=current_user_id, detail=f"provider={provider}",
        ip_address=request.client.host if request.client else None,
    )
    await session.commit()
    return _ok({"provider": provider, "linked": True})


@router.post("/oauth/{provider}/unlink")
async def oauth_unlink(
    provider: str,
    request: Request,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> JSONResponse:
    if provider not in _OAUTH_CONFIGS:
        return _err("INVALID_PROVIDER", f"Unsupported provider: {provider}", 400)

    user = await _get_user_by_id(session, uuid.UUID(auth.user_id))
    if user is None:
        return _err("USER_NOT_FOUND", "User not found", 404)

    id_col_name = f"{provider}_id"
    if getattr(user, id_col_name) is None:
        return _err("PROVIDER_NOT_LINKED", f"No {provider} account linked", 400)

    # AC3 — 로그인 수단이 이거 하나뿐이면 해제 거부(계정 잠금 방지). 비밀번호 + 등록된
    # provider 전부를 센다(구글/애플뿐 아니라 향후 provider 추가돼도 자동 정합).
    login_method_count = (1 if user.hashed_password else 0) + sum(
        1 for p in _OAUTH_CONFIGS if getattr(user, f"{p}_id") is not None
    )
    if login_method_count <= 1:
        return _err("LAST_LOGIN_METHOD", "Cannot unlink your only sign-in method", 400)

    await session.execute(update(User).where(User.id == user.id).values(**{id_col_name: None}))
    await _write_audit(
        session, "oauth_unlink", user_id=user.id, detail=f"provider={provider}",
        ip_address=request.client.host if request.client else None,
    )
    await session.commit()
    return _ok({"provider": provider, "linked": False})


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
        from app.services.agent_onboarding_config import resolve_locale
        from app.services.email import render_action_email, send_email
        from app.services.email_copy import TRANSACTIONAL_COPY
        locale = resolve_locale(user.locale)
        copy = TRANSACTIONAL_COPY["reset_password"][locale]
        send_email(
            to=user.email,
            subject=copy["subject"],
            html_body=render_action_email(
                intro_lines=copy["intro_lines"],
                cta_label=copy["cta_label"],
                cta_url=reset_link,
                locale=locale,
                expiry_note=copy["expiry_note"],
                security_note=copy["security_note"],
                fallback_label=copy["fallback_label"],
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
        update(User).where(User.id == user.id).values(
            hashed_password=hash_password(body.new_password),
            password_set_at=datetime.now(timezone.utc),
        )
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
        update(User).where(User.id == user.id).values(
            hashed_password=hash_password(body.new_password),
            password_set_at=datetime.now(timezone.utc),
        )
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
        update(User).where(User.id == user.id).values(
            hashed_password=hash_password(body.new_password),
            password_set_at=datetime.now(timezone.utc),
        )
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
# story #2444: 어뷰징 방지 목적(선생님 명시) — 공유 in-memory limiter(다른 8개 auth 라우트,
# login/refresh 가용성 우선으로 무접촉) 대신 격리된 Redis-backed limiter로 인스턴스 수와
# 무관한 전역 3/hour 강제(AC1) + Redis 장애 시 fail-closed(AC3, main.py StorageError 핸들러).
@resend_verification_limiter.limit("3/hour")
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
    # story #3196-⑤ — register()의 인증메일과 동일 카피/렌더러(발명 0, 같은 내용의 재발송이라
    # 두 벌 카피를 유지할 이유가 없다 — 여태 문자 그대로 중복이었던 자리 그대로 정합).
    # story #3205 — locale 분기도 register()와 동일 사전(TRANSACTIONAL_COPY) 재사용.
    from app.services.agent_onboarding_config import resolve_locale
    from app.services.email import render_action_email, send_email
    from app.services.email_copy import TRANSACTIONAL_COPY
    locale = resolve_locale(user.locale)
    copy = TRANSACTIONAL_COPY["verify_email"][locale]
    delivered = send_email(
        to=user.email,
        subject=copy["subject"],
        html_body=render_action_email(
            intro_lines=copy["intro_lines"],
            cta_label=copy["cta_label"],
            cta_url=verify_link,
            expiry_note=copy["expiry_note"],
            security_note=copy["security_note"],
            fallback_label=copy["fallback_label"],
            locale=locale,
        ),
    )
    if not delivered:
        # 콘솔 폴백(미발송)을 "sent"로 거짓 보고하지 않는다(데모 디버깅 가시화).
        # SPR-13: 운영자가 로그로 인증을 완료할 수 있게 링크 포함(register 폴백과 동일).
        logger.warning(
            "resend-verification: 인증 이메일 미발송(콘솔 폴백) user_id=%s email=%s 인증 링크: %s",
            user.id, user.email, verify_link,
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

    # E-SECURITY SEC-S8(story 83ea3d6a) K — org_id 미전달이면 has_project_access가 org 필터
    # 없이 판정해, J(cross-org project_access grant)로 생긴 행 하나만 있어도 target org의
    # 정식 access+refresh 토큰이 발급되는 증폭 경로였다(SEC-S5~S8 가드를 우회하는 크리덴셜
    # 발급 자체이므로 단순 열람보다 파급이 큼). 현재 세션의 org 컨텍스트로 명시 스코핑.
    caller_org_id_str = auth.claims.get("app_metadata", {}).get("org_id")
    caller_org_id = uuid.UUID(str(caller_org_id_str)) if caller_org_id_str else None

    # 인가 체크 — team_member ∪ project_access(granted) ∪ owner/admin (me/memberships 3-branch 정합)
    if not await has_project_access(session, user.id, body.project_id, caller_org_id):
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
    # E-MCP-OPT(story ff6cb90d·doc mcp-multiproject-scoping-design §0/§1): 위 project_id(레거시,
    # _resolve_api_key의 ORDER BY 임의 기본값)는 무변경 유지(기존 48개 mutation 라우트가 항상 값이
    # 있다고 가정하는 blast radius 회피) — 아래 3필드가 근본 정의한 신규 계약. 무인자 기본값을
    # "정확히" 판정: 단일 접근가능 프로젝트 or 명시 default_project_id만 신뢰, 그 외엔 추측 0(null).
    resolved_default_project_id: str | None = None
    is_project_ambiguous: bool = False
    accessible_project_ids: list[str] = []
    # story #3195(온보딩·FE) — 온보딩 1/4가 "이메일 인증 필요"를 제출(400) 前에 선제 고지하려면
    # 이 신호가 필요했다. api_key 컨텍스트(에이전트)는 User 행이 없어 None(무의미 — 온보딩 게이트
    # 자체가 인간 전용이라 agent 소비처는 이 필드를 참조하지 않는다).
    email_verified: bool | None = None


async def _resolve_project_default(
    session: AsyncSession, member_id: uuid.UUID, org_id: uuid.UUID,
) -> tuple[str | None, bool, list[str]]:
    """doc mcp-multiproject-scoping-design §1 — 신규 근본 판정(추측 금지).

    단일 접근가능 프로젝트면 그대로(무회귀·에러 불필요) · 2개 이상이면 명시 default_project_id가
    여전히 접근가능할 때만 사용 · 그 외(2개 이상 + 미설정/무효)엔 resolved=None + ambiguous=True로
    호출자가 명시하게 한다(암묵 first-project 선택 금지)."""
    accessible = await accessible_project_ids_in_org(session, member_id, org_id)
    accessible_ids = [str(p) for p in accessible]
    if len(accessible_ids) == 1:
        return accessible_ids[0], False, accessible_ids
    if not accessible_ids:
        return None, False, accessible_ids  # 접근 가능 프로젝트 자체가 0 — 별개 문제(ambiguous 아님).
    member_row = (await session.execute(
        select(Member.default_project_id).where(Member.id == member_id)
    )).scalar_one_or_none()
    if member_row is not None and str(member_row) in accessible_ids:
        return str(member_row), False, accessible_ids
    return None, True, accessible_ids


@router.get("/me", response_model=AuthMeResponse)
async def get_auth_me(
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AuthMeResponse:
    """API Key Bearer 인증으로 바인딩된 member_id, org_id, project_id 반환.

    E-MCP-OPT: agent API 키(멀티프로젝트 가능)에 한해 resolved_default_project_id/
    is_project_ambiguous/accessible_project_ids를 근본 판정(§1)해 추가 — human JWT 경로는
    무변경(기본값 그대로, 이 스토리 스코프 밖)."""
    meta = auth.claims.get("app_metadata", {})
    resolved: str | None = None
    ambiguous = False
    accessible_ids: list[str] = []
    email_verified: bool | None = None
    if meta.get("api_key_id"):
        try:
            member_id = uuid.UUID(auth.user_id)
            org_id = uuid.UUID(str(auth.org_id or meta.get("org_id")))
            resolved, ambiguous, accessible_ids = await _resolve_project_default(db, member_id, org_id)
        except Exception:
            logger.warning("get_auth_me: 신규 project default 판정 실패 — 레거시 필드만 반환", exc_info=True)
    else:
        # story #3195 — human JWT 세션(auth.user_id == User.id)에 한해서만 조회. api_key
        # 컨텍스트는 위 분기라 여기 안 온다(불필요 쿼리 회피).
        try:
            email_verified = (
                await db.execute(select(User.email_verified).where(User.id == uuid.UUID(auth.user_id)))
            ).scalar_one_or_none()
        except Exception:
            logger.warning("get_auth_me: email_verified 조회 실패 — None으로 반환", exc_info=True)
    return AuthMeResponse(
        member_id=auth.user_id,
        org_id=auth.org_id or meta.get("org_id"),
        project_id=meta.get("project_id"),
        resolved_default_project_id=resolved,
        is_project_ambiguous=ambiguous,
        accessible_project_ids=accessible_ids,
        email_verified=email_verified,
    )


class SetDefaultProjectRequest(BaseModel):
    project_id: uuid.UUID


@router.patch("/me/default-project", response_model=AuthMeResponse)
async def set_default_project(
    body: SetDefaultProjectRequest,
    auth: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AuthMeResponse:
    """E-MCP-OPT(story ff6cb90d §3) — 멀티프로젝트 키의 기본 프로젝트 서버 저장(감사 가능).

    write-time 강제: 지정 project_id가 caller의 accessible 집합 안에 있어야 함(cross-org/무권한
    프로젝트 지정 차단·body-claimed 금지)."""
    meta = auth.claims.get("app_metadata", {})
    member_id = uuid.UUID(auth.user_id)
    org_id = uuid.UUID(str(auth.org_id or meta.get("org_id")))
    if not await has_project_access(db, member_id, body.project_id, org_id):
        raise HTTPException(status_code=403, detail="No access to the specified project")

    member = (await db.execute(select(Member).where(Member.id == member_id))).scalar_one_or_none()
    if member is None:
        raise HTTPException(status_code=404, detail="Member not found")

    member.default_project_id = body.project_id
    await db.flush()
    # story #2132(2026-07-23): member.default_project_changed의 publish_event() 호출 제거 —
    # FE 소비처 0(설계 doc `story-2139-2132-publish-event-unification-design` §1) + 그
    # 죽은 org-level fanout(`_subscribers`) 자체가 삭제됨. 복구 대상 아님(신기능 스코프 밖).
    await db.commit()

    resolved, ambiguous, accessible_ids = await _resolve_project_default(db, member_id, org_id)
    return AuthMeResponse(
        member_id=str(member_id),
        org_id=str(org_id),
        project_id=meta.get("project_id"),
        resolved_default_project_id=resolved,
        is_project_ambiguous=ambiguous,
        accessible_project_ids=accessible_ids,
    )
