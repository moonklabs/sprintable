from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.org_invite import OrgInvite
from app.models.organization import Organization
from app.models.project import OrgMember, Project


@dataclass
class InvitePreview:
    org_name: str
    role: str
    status: str
    expires_at: datetime
    email: str
    # 정책B surface②: 수락 시 부여될 프로젝트 [{id, name}] — invitee는 org 접근 전이라 FE가 못 받음.
    projects: list[dict] = field(default_factory=list)

_INVITE_EXPIRE_DAYS = 7


class OrgInviteRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def is_already_member(self, org_id: uuid.UUID, email: str) -> bool:
        """해당 org에 이미 가입된 email 여부 확인."""
        from app.models.user import User
        result = await self.session.execute(
            select(OrgMember.id)
            .join(User, User.id == OrgMember.user_id)
            .where(
                OrgMember.org_id == org_id,
                User.email == email.lower().strip(),
                OrgMember.deleted_at.is_(None),
            )
            .limit(1)
        )
        return result.scalar_one_or_none() is not None

    async def has_pending_invite(self, org_id: uuid.UUID, email: str) -> bool:
        """같은 org+email의 pending 초대가 이미 존재하는지 확인."""
        result = await self.session.execute(
            select(OrgInvite.id).where(
                OrgInvite.organization_id == org_id,
                OrgInvite.email == email.lower().strip(),
                OrgInvite.status == "pending",
            ).limit(1)
        )
        return result.scalar_one_or_none() is not None

    async def create(
        self,
        org_id: uuid.UUID,
        email: str,
        role: str,
        created_by: uuid.UUID,
        project_ids: list[uuid.UUID] | None = None,
    ) -> OrgInvite | None:
        """초대 생성. pending 중복(org+email) 시 None 반환 (revoke 후 재초대 허용).

        project_ids: 정책B — accept 시 부여할 프로젝트(선택). JSONB에 str uuid 배열로 저장.
        """
        if await self.has_pending_invite(org_id=org_id, email=email):
            return None
        now = datetime.now(timezone.utc)
        invite = OrgInvite(
            organization_id=org_id,
            email=email.lower().strip(),
            role=role,
            expires_at=now + timedelta(days=_INVITE_EXPIRE_DAYS),
            created_by=created_by,
            project_ids=[str(p) for p in (project_ids or [])],
        )
        self.session.add(invite)
        try:
            await self.session.flush()
            await self.session.refresh(invite)
        except IntegrityError:
            await self.session.rollback()
            return None
        return invite

    async def list_pending(self, org_id: uuid.UUID) -> list[OrgInvite]:
        """pending + 미만료 초대 목록 (최신순)."""
        now = datetime.now(timezone.utc)
        result = await self.session.execute(
            select(OrgInvite)
            .where(
                OrgInvite.organization_id == org_id,
                OrgInvite.status == "pending",
                OrgInvite.expires_at > now,
            )
            .order_by(OrgInvite.created_at.desc())
        )
        return list(result.scalars().all())

    async def get_by_token(self, token: str) -> OrgInvite | None:
        result = await self.session.execute(
            select(OrgInvite).where(OrgInvite.token == token)
        )
        return result.scalar_one_or_none()

    async def update_email_result(
        self, invite_id: uuid.UUID, *, sent_at: datetime | None, error: str | None
    ) -> None:
        """이메일 발송 결과를 invite 레코드에 기록."""
        result = await self.session.execute(
            select(OrgInvite).where(OrgInvite.id == invite_id)
        )
        invite = result.scalar_one_or_none()
        if invite is None:
            return
        invite.email_sent_at = sent_at
        invite.email_error = error
        await self.session.flush()

    async def resend(self, invite_id: uuid.UUID, org_id: uuid.UUID) -> OrgInvite | None:
        """재발송: expires_at 갱신 + email 트래킹 초기화. 해당 org pending 초대만 대상."""
        result = await self.session.execute(
            select(OrgInvite).where(
                OrgInvite.id == invite_id,
                OrgInvite.organization_id == org_id,
                OrgInvite.status == "pending",
            )
        )
        invite = result.scalar_one_or_none()
        if invite is None:
            return None
        invite.expires_at = datetime.now(timezone.utc) + timedelta(days=_INVITE_EXPIRE_DAYS)
        invite.email_sent_at = None
        invite.email_error = None
        await self.session.flush()
        await self.session.refresh(invite)
        return invite

    async def get_preview(self, token: str) -> InvitePreview | None:
        """token으로 초대 + org 이름 조회. 미존재 시 None."""
        result = await self.session.execute(
            select(OrgInvite, Organization.name)
            .join(Organization, Organization.id == OrgInvite.organization_id)
            .where(OrgInvite.token == token)
        )
        row = result.first()
        if row is None:
            return None
        invite, org_name = row
        now = datetime.now(timezone.utc)
        effective_status = (
            "expired" if invite.status == "pending" and invite.expires_at < now else invite.status
        )
        # surface②: invite.project_ids → 프로젝트 이름 해소(invite org 소속만·cross-org 방지)
        projects: list[dict] = []
        pids_raw = invite.project_ids or []
        if pids_raw:
            wanted = []
            for p in pids_raw:
                try:
                    wanted.append(uuid.UUID(str(p)))
                except (ValueError, TypeError):
                    continue
            if wanted:
                rows = await self.session.execute(
                    select(Project.id, Project.name).where(
                        Project.id.in_(wanted),
                        Project.org_id == invite.organization_id,
                        Project.deleted_at.is_(None),
                    )
                )
                projects = [{"id": str(pid), "name": name} for pid, name in rows.all()]
        return InvitePreview(
            org_name=org_name,
            role=invite.role,
            status=effective_status,
            expires_at=invite.expires_at,
            email=invite.email,
            projects=projects,
        )

    async def accept(self, token: str, user_id: uuid.UUID, user_email: str) -> dict:
        """초대 수락. 성공 시 org_id/role 반환. 실패 시 reason 포함."""
        result = await self.session.execute(
            select(OrgInvite).where(OrgInvite.token == token)
        )
        invite = result.scalar_one_or_none()
        if invite is None:
            return {"ok": False, "reason": "not_found"}
        if invite.status == "accepted":
            # Idempotent: the same invitee re-accepting (double-click / re-visit / back button)
            # is already a member → treat as success rather than a 409 error. Only a *different*
            # user hitting an already-consumed invite gets already_accepted.
            if invite.email.lower() == user_email.lower():
                # ensure membership exists (prior accept may predate a backfill) — idempotent
                await self.session.execute(
                    pg_insert(OrgMember)
                    .values(
                        org_id=invite.organization_id,
                        user_id=user_id,
                        role=invite.role,
                    )
                    .on_conflict_do_nothing(constraint="uq_org_members_org_user")
                )
                await self.session.flush()
                # 수락자 휴먼 members 앵커 보장(#1317 휴먼판): 재수락 경로도 누락 복구
                await self._ensure_member_anchor(invite.organization_id, user_id)
                # 정책B: 선택 프로젝트 project_access도 멱등 보장(재수락 시 누락 복구)
                await self._grant_invite_project_access(invite, user_id)
                return {
                    "ok": True,
                    "org_id": str(invite.organization_id),
                    "role": invite.role,
                    "already_member": True,
                }
            return {"ok": False, "reason": "already_accepted"}
        if invite.status != "pending":
            return {"ok": False, "reason": "invalid_status"}
        if invite.expires_at < datetime.now(timezone.utc):
            return {"ok": False, "reason": "expired"}
        if invite.email.lower() != user_email.lower():
            return {"ok": False, "reason": "email_mismatch"}

        # org_member 생성 (중복 시 무시)
        await self.session.execute(
            pg_insert(OrgMember)
            .values(
                org_id=invite.organization_id,
                user_id=user_id,
                role=invite.role,
            )
            .on_conflict_do_nothing(constraint="uq_org_members_org_user")
        )
        await self.session.flush()

        # 수락자 휴먼 members 앵커 보장(#1317 휴먼판): created_by NULL·DM 403 공통 뿌리 해소
        await self._ensure_member_anchor(invite.organization_id, user_id)

        # 정책B: 초대 시 선택한 프로젝트에 project_access(granted) 부여
        await self._grant_invite_project_access(invite, user_id)

        invite.status = "accepted"
        invite.accepted_at = datetime.now(timezone.utc)
        await self.session.flush()

        return {"ok": True, "org_id": str(invite.organization_id), "role": invite.role}

    async def _ensure_member_anchor(self, org_id: uuid.UUID, user_id: uuid.UUID) -> None:
        """수락자(휴먼)의 canonical members 앵커(type='human', id=org_member.id)를 멱등 보장.

        org_member upsert 직후 그 org_member.id를 재조회해 ensure_human_member 호출.
        앵커 부재 시 created_by NULL·assignee 누락·DM 403의 공통 뿌리가 된다(#1317 휴먼판).
        """
        from app.services.agent_anchor_sync import ensure_human_member

        om_id = (
            await self.session.execute(
                select(OrgMember.id).where(
                    OrgMember.org_id == org_id,
                    OrgMember.user_id == user_id,
                    OrgMember.deleted_at.is_(None),
                ).limit(1)
            )
        ).scalar_one_or_none()
        if om_id is not None:
            await ensure_human_member(self.session, om_id)

    async def _grant_invite_project_access(self, invite: OrgInvite, user_id: uuid.UUID) -> None:
        """초대 시 선택한 프로젝트(invite.project_ids)에 수락 멤버의 project_access(granted) 부여.

        cross-org grant 방지: invite.organization_id 소속 프로젝트만 대상(검증). 멱등(on_conflict).
        """
        pids_raw = invite.project_ids or []
        if not pids_raw:
            return
        from app.models.project import Project
        from app.models.project_access import ProjectAccess

        # 수락 멤버의 org_member.id 해소
        om_id = (
            await self.session.execute(
                select(OrgMember.id).where(
                    OrgMember.org_id == invite.organization_id,
                    OrgMember.user_id == user_id,
                    OrgMember.deleted_at.is_(None),
                ).limit(1)
            )
        ).scalar_one_or_none()
        if om_id is None:
            return

        # 문자열 uuid 파싱 + invite org 소속 프로젝트만 (cross-org 방지)
        wanted: list[uuid.UUID] = []
        for p in pids_raw:
            try:
                wanted.append(uuid.UUID(str(p)))
            except (ValueError, TypeError):
                continue
        if not wanted:
            return
        valid_rows = await self.session.execute(
            select(Project.id).where(
                Project.id.in_(wanted),
                Project.org_id == invite.organization_id,
                Project.deleted_at.is_(None),
            )
        )
        for (pid,) in valid_rows.all():
            await self.session.execute(
                pg_insert(ProjectAccess.__table__)
                .values(
                    id=uuid.uuid4(),
                    project_id=pid,
                    org_member_id=om_id,
                    permission="granted",
                    role=invite.role,
                    access_source="direct",
                )
                .on_conflict_do_nothing(constraint="uq_project_access_project_member")
            )
        await self.session.flush()

    async def revoke(self, invite_id: uuid.UUID, org_id: uuid.UUID) -> OrgInvite | None:
        result = await self.session.execute(
            select(OrgInvite).where(
                OrgInvite.id == invite_id,
                OrgInvite.organization_id == org_id,
            )
        )
        invite = result.scalar_one_or_none()
        if invite is None:
            return None
        invite.status = "revoked"
        await self.session.flush()
        await self.session.refresh(invite)
        return invite
