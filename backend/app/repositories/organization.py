from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.deletion_audit import DeletionAuditLog
from app.models.organization import Organization
from app.models.participation import ParticipationRole
from app.models.project import OrgMember, Project
from app.services.org_subscription_checkout import STALE_CLAIM_WINDOW

logger = logging.getLogger(__name__)

# SID 265f5b13/#2049 AC1: 신규 조직 생성 직후 참여 역할 세트가 하나도 안 만들어져
# `resolve_implementation_participation`(app/services/verdict_capture.py:55-63)이 항상
# is_default=True 역할을 못 찾고 None을 반환 — merge 게이트가 신규 조직 전부에서 원천적으로
# 안 만들어지는 P0였다(#2047 AC5 라이브 검증 중 발견: dev 테스트 조직 4곳 중 3곳은 role 0,
# 1곳은 is_default 없는 role 1개뿐). 뭉클랩(유일하게 정상 동작하는 조직)이 실측으로 보유한
# 5종 세트(implementation/po/qa/design/devops, 전부 2026-05-31 동시 생성)를 그대로 재사용한다
# — `hypothesis_owner`(2026-06-13 추가)는 다른 시점에 다른 경로로 생긴 역할이라 이 "기본 세트"
# 결정에서 제외한다(근거: created_at이 나머지 5개와 다름 → 별도 기능의 부산물로 판단).
DEFAULT_PARTICIPATION_ROLES: tuple[tuple[str, str, bool], ...] = (
    ("implementation", "구현", True),
    ("po", "PO", False),
    ("qa", "QA", False),
    ("design", "디자인", False),
    ("devops", "DevOps", False),
)


@dataclass
class OrgImpact:
    project_count: int
    member_count: int
    has_active_subscription: bool


@dataclass
class OrganizationWithRole:
    id: uuid.UUID
    name: str
    slug: str
    plan: str
    role: str
    timezone: str | None = None


class OrganizationRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get(self, org_id: uuid.UUID) -> Organization | None:
        result = await self.session.execute(
            select(Organization).where(Organization.id == org_id)
        )
        return result.scalar_one_or_none()

    async def slug_exists(self, slug: str) -> bool:
        result = await self.session.execute(
            select(Organization.id).where(Organization.slug == slug)
        )
        return result.scalar_one_or_none() is not None

    async def get_by_slug(self, slug: str) -> Organization | None:
        """story 139d2405(S-slug-infra): workspace slug 해소용(slug 전역 유일)."""
        result = await self.session.execute(
            select(Organization).where(Organization.slug == slug)
        )
        return result.scalar_one_or_none()

    async def create(self, name: str, slug: str, owner_member_id: uuid.UUID | None) -> Organization | None:
        if await self.slug_exists(slug):
            return None
        org = Organization(name=name, slug=slug)
        self.session.add(org)
        await self.session.flush()
        await self.session.refresh(org)
        # SID 265f5b13/#2049 AC1: 참여 역할 세트를 org 생성과 함께 심어 merge 게이트(및
        # participation을 전제하는 다른 모든 경로)가 신규 조직에서도 처음부터 동작하게 한다.
        self.session.add_all([
            ParticipationRole(org_id=org.id, key=key, label=label, is_default=is_default)
            for key, label, is_default in DEFAULT_PARTICIPATION_ROLES
        ])
        if owner_member_id is not None:
            await self.session.execute(
                text(
                    "INSERT INTO org_members (org_id, user_id, role)"
                    " SELECT :org_id, user_id, 'owner' FROM team_members WHERE id = :member_id"
                    " ON CONFLICT (org_id, user_id) DO NOTHING"
                ),
                {"org_id": str(org.id), "member_id": str(owner_member_id)},
            )
        # fresh org에 default implementation 역할 시드 — 없으면 merge gate가
        # "no implementation participation"으로 gate row 없이 영구 보류(교착).
        from app.services.participation_helpers import seed_default_participation_role

        await seed_default_participation_role(self.session, org.id)
        return org

    async def list_for_user(self, user_id: uuid.UUID) -> list[OrganizationWithRole]:
        """사용자가 org_members로 속한 Organization 목록 반환 (name ASC)."""
        result = await self.session.execute(
            select(
                Organization.id,
                Organization.name,
                Organization.slug,
                Organization.plan,
                Organization.timezone,
                OrgMember.role,
            )
            .join(OrgMember, OrgMember.org_id == Organization.id)
            .where(
                OrgMember.user_id == user_id,
                OrgMember.deleted_at.is_(None),
            )
            .order_by(Organization.name.asc())
        )
        return [
            OrganizationWithRole(
                id=row.id, name=row.name, slug=row.slug, plan=row.plan, role=row.role, timezone=row.timezone,
            )
            for row in result.all()
        ]

    async def get_member_role(self, org_id: uuid.UUID, user_id: uuid.UUID) -> str | None:
        """org_members에서 user의 role 반환. 미소속 시 None."""
        result = await self.session.execute(
            select(OrgMember.role).where(
                OrgMember.org_id == org_id,
                OrgMember.user_id == user_id,
                OrgMember.deleted_at.is_(None),
            )
        )
        return result.scalar_one_or_none()

    async def update_name(self, org_id: uuid.UUID, name: str) -> Organization | None:
        """Organization 이름 수정 후 갱신된 객체 반환. 미존재 시 None."""
        org = await self.get(org_id)
        if org is None:
            return None
        org.name = name
        await self.session.flush()
        await self.session.refresh(org)
        return org

    async def _has_active_or_in_flight_subscription(self, org_id: uuid.UUID) -> bool:
        """구독 status='active'뿐 아니라 #2511(결제②-D후속) checkout_claimed_at이
        STALE_CLAIM_WINDOW 안(=진행 中)인 claim도 "활성"으로 취급한다.

        카디르 결함사냥 HIGH②(#2898 재QA, 2026-08-07) — checkout claim 성공 直後(구독
        status는 아직 'pending', active 아님)의 그 창에서는 이 체크가 놓쳤다: org 삭제가
        (구독 status='active' 아님이라) 통과해버리면, 뒤늦게 그 checkout의 charge가
        confirmed돼도 org가 이미 사라진 뒤라 **삭제된 org에 실 청구가 완료**될 수 있었다
        (#2896 step④ CAS는 org_id 매칭이라 org 삭제 자체는 못 막는 축). #2511과 동일
        STALE_CLAIM_WINDOW/SSOT로 "진행 中"을 판정 — 죽은/멈춘(stale) claim은 여전히
        무시(자기치유 회귀 없음)."""
        now = datetime.now(timezone.utc)
        row = await self.session.execute(
            text(
                "SELECT 1 FROM org_subscriptions WHERE org_id = :org_id AND ("
                " status = 'active'"
                " OR (checkout_claimed_at IS NOT NULL AND checkout_claimed_at >= :stale_cutoff)"
                ") LIMIT 1"
            ),
            {"org_id": str(org_id), "stale_cutoff": now - STALE_CLAIM_WINDOW},
        )
        return row.first() is not None

    async def get_impact(self, org_id: uuid.UUID) -> OrgImpact:
        """삭제 전 영향도 조회 — project 수, member 수, 활성(또는 진행 中 checkout claim)
        subscription 여부."""
        proj_count_row = await self.session.execute(
            select(func.count()).select_from(Project).where(
                Project.org_id == org_id,
                Project.deleted_at.is_(None),
            )
        )
        project_count = proj_count_row.scalar() or 0

        member_count_row = await self.session.execute(
            select(func.count()).select_from(OrgMember).where(
                OrgMember.org_id == org_id,
                OrgMember.deleted_at.is_(None),
            )
        )
        member_count = member_count_row.scalar() or 0

        has_active_subscription = await self._has_active_or_in_flight_subscription(org_id)

        return OrgImpact(
            project_count=project_count,
            member_count=member_count,
            has_active_subscription=has_active_subscription,
        )

    async def delete_by_user(
        self, org_id: uuid.UUID, user_id: uuid.UUID, confirmation: str,
        confirm_without_impact: bool = False,
    ) -> dict:
        """owner 전용 삭제 — user_id로 직접 권한 검증 + confirmation 문자열 검사.

        #2092(P0 보안, 유나 발견 2026-07-22) — 이전엔 GET /{id}/impact(영향도 미리보기)와
        이 삭제 자체가 서버에서 완전히 무관계였다. 화면이 조회 실패 상태에서도 "계속
        진행해도 됩니다"라고 권했고, 설령 화면 카피를 고쳐도 서버가 impact 조회 성공
        여부를 아예 안 보므로 API 직접 호출로 그대로 뚫렸다(카피 수정만으론 동작 결함이
        안 닫힌다는 게 story 원문 핵심).

        fix: 삭제 직전 서버가 **직접** get_impact()를 재조회한다(클라이언트가 "조회
        실패했다"고 주장하는 걸 신뢰하지 않는다 — 서버 자신의 조회 성패만 신뢰). 그 재조회
        자체가 실패하면 confirm_without_impact=True(사용자가 "확認하지 못한 상태로
        삭제합니다"를 명시 인정)가 아닌 한 거부한다. override로 진행된 삭제는
        DeletionAuditLog.note에 그 사실을 남긴다(AC3 "확認 없이 삭제한 것으로 기록됩니다").

        카디르 결함사냥 TOCTOU-fix(3차 재QA, #2898 리뷰, 2026-08-07) — 이전엔 "재확認"
        헬퍼 체크가 실제로는 딱 한 번뿐이었고, savepoint로 감싼 두 번째 get_impact()
        호출은 반환값을 버려("에러 안 났나"만 보는 부작용용) 재확認이 실은 재확認이
        아니었다. 그 헬퍼 통과~실 delete 사이(여러 statement)에 별도 커넥션이 checkout
        claim을 UPSERT+commit해도(org_subscriptions.org_id는 organizations에 FK가
        없어 DB가 이 경쟁을 원천 차단 안 함, READ COMMITTED) 못 잡는 TOCTOU였다.

        근본 fix: org 행 자체를 `FOR UPDATE`로 잠근다(함수 시작, 다른 모든 체크보다
        먼저) — checkout claim UPSERT 경로(org_subscription_checkout.py)도 자기
        claim 시작 前에 같은 org 행을 FOR UPDATE로 잠그므로, 이 행을 두고 둘이
        Postgres 자체의 행 잠금으로 직렬화된다. 어느 쪽이 먼저 잠그든 "창"이 없다 —
        삭제가 먼저면 checkout이 커밋된 삭제 後 org 없음으로 실패, checkout이 먼저면
        삭제가 그 lock 해제(=claim 커밋) 後에야 재조회해 "진행 中"을 정확히 본다.
        재조회(get_impact) 반환값도 이제 실제 게이트로 쓴다(버리지 않는다)."""
        lock_result = await self.session.execute(
            select(Organization).where(Organization.id == org_id).with_for_update()
        )
        org = lock_result.scalar_one_or_none()
        if org is None:
            return {"ok": False, "reason": "not_found"}

        role = await self.get_member_role(org_id=org_id, user_id=user_id)
        if role != "owner":
            return {"ok": False, "reason": "forbidden"}

        if confirmation != org.name:
            return {"ok": False, "reason": "confirmation_mismatch"}

        # 카디르 결함사냥 HIGH①(#2898 2차 재QA, 2026-08-07) — get_impact()가 진짜
        # Postgres 에러로 실패하면 그 커넥션의 트랜잭션 자체가 "aborted" 상태로
        # 오염된다. override(confirm_without_impact=True)로 진행해도 그 아래
        # audit-log insert·org delete가 같은(오염된) 트랜잭션 위에서 실행되므로
        # 조용히 실패하거나, 이 함수는 {"ok": True}를 반환했는데 실제로는 아무것도
        # 안 지워지고 라우터의 후속 commit(try/except 없음)에서야 500이 터졌다 —
        # override라는 탈출구가 정작 가장 현실적인 실패(진짜 DB 에러)에서 "깨끗한
        # 성공도 깨끗한 실패도 아닌 500"이 되는 게 근본 결함. get_impact() 호출을
        # SAVEPOINT(begin_nested)로 감싸 실패해도 바깥 트랜잭션(FOR UPDATE 락 포함)은
        # 오염되지 않게 한다 — 그 아래 audit insert·delete는 항상 깨끗한 트랜잭션
        # 위에서 실행된다.
        impact_note: str | None = None
        try:
            async with self.session.begin_nested():
                impact = await self.get_impact(org_id=org_id)
        except Exception:
            logger.warning(
                "org.delete.impact_check_failed org_id=%s confirm_without_impact=%s",
                org_id, confirm_without_impact, exc_info=True,
            )
            if not confirm_without_impact:
                return {"ok": False, "reason": "impact_unavailable"}
            impact_note = "영향도(impact) 확認 없이 삭제됨 — 조회 실패 상태에서 사용자가 명시적으로 진행을 인정"
        else:
            # 반환값을 실제로 쓴다 — FOR UPDATE로 잠근 이 시점 기준 최신 상태(checkout이
            # 락 대기 中이었다면 이 재조회 前에 이미 커밋 완료된 뒤이므로 여기 반영됨).
            if impact.has_active_subscription:
                return {"ok": False, "reason": "active_subscription"}

        self.session.add(DeletionAuditLog(
            id=uuid.uuid4(), org_id=org_id, actor_id=user_id,
            entity_type="organization", entity_id=org_id, entity_title=org.name,
            note=impact_note,
        ))
        await self.session.delete(org)
        return {"ok": True}

    # #2092(카디르 결함사냥, #2898 리뷰, 2026-08-07) — 구 delete(org_id, requester_member_id)
    # 메서드를 제거했다. 이 fix가 새로 만든 안전장치(impact 재조회+savepoint 격리·human-only
    # 강제(라우터)·checkout_claimed_at 인지·DeletionAuditLog 기입) 전부가 이 메서드에는
    # 하나도 없었다 — 호출부가 현재 0곳(grep 확認, 죽은 코드)이지만, 살려두면 향후 누군가
    # "더 짧으니까" 실수로 이걸 다시 배선해 이번 fix 전체를 조용히 무력화하는 "부활 경로"가
    # 된다. 그 경로 자체를 없앤다 — private화(밑줄)가 아니라 삭제, 죽은 트랩은 존재 자체가
    # 위험이라 남겨둘 이유가 없다.
