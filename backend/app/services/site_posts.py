"""story #3360(발행 구조·서버, 선생님 확定 2026-09-03) — 자사 사이트 글 저장/조회.

**서버 chokepoint**(story 본문 §2): work item의 external_publish 게이트가 approved/
auto_passed가 아니면 발행 자체가 안 된다 — git 커밋이 승인 증거였던 자리를, 이 SitePost 행의
gate_id·created_at이 그대로 대신한다."""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.models.gate import Gate, set_gate_status
from app.models.site_post import SitePost
from app.models.site_post_draft import SitePostDraft
from app.models.site_post_version import SitePostVersion
from app.models.team import TeamMember

_SLUG_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
_LANG_RE = re.compile(r"^[a-z]{2}(-[A-Z]{2})?$")

_APPROVED_STATUSES = ("approved", "auto_passed")


class InvalidSitePostInputError(ValueError):
    """slug/lang이 서버 형식 규칙을 어김(422)."""


class MediaNotSupportedPhase0Error(ValueError):
    """Phase 0엔 미디어 입력이 없다 — manifest가 비어 있지 않으면 422(story #3365 AC5)."""


class ExternalPublishGateNotApprovedError(Exception):
    """work item의 external_publish 게이트가 approved/auto_passed가 아님(403). gate_id·
    status를 담아 사유 문구에 그대로 노출한다(story 본문 §2 명시)."""

    def __init__(self, *, gate_id: uuid.UUID | None, status: str | None):
        self.gate_id = gate_id
        self.status = status
        detail = (
            f"external_publish 게이트가 승인되지 않았습니다(gate_id={gate_id}, status={status})"
            if gate_id is not None
            else "이 work item에 승인된 external_publish 게이트가 없습니다"
        )
        super().__init__(detail)


class SitePostReapprovalRequiredError(Exception):
    """story #3365(Phase0 S2) AC6 — 승인된 버전(gate.sealed_content_sha256)과 지금 공개하려는
    내용의 해시가 다르다."""

    def __init__(self, *, gate_id: uuid.UUID):
        self.gate_id = gate_id
        super().__init__(f"승인된 버전과 현재 내용이 다릅니다(gate_id={gate_id}) — 재승인이 필요합니다")


class SitePostSealMissingError(Exception):
    """story #3365(Phase0 S2, 페드루 PO 리뷰 2026-09-03 05:59Z) — fail-closed. gate.status가
    approved/auto_passed인데 sealed_content_sha256이 None(제출→봉인 없이 승인된 구식/우회
    게이트)이면, "무엇이 승인됐는지 서버가 모른다"는 뜻이라 REAPPROVAL_REQUIRED(내용이
    다르다는 걸 안다)와는 다른 별개 코드로 거부한다(유나 설계 §3-1-1 "모른다≠다르다").
    S2 이전 이미 공개된 SitePost 행은 이 검사와 무관(projection 자체는 안 건드림) — 이
    게이트로 다시 발행을 시도할 때만 막힌다(재발행은 submit()으로 재상신해 봉인부터)."""

    def __init__(self, *, gate_id: uuid.UUID):
        self.gate_id = gate_id
        super().__init__(f"이 게이트는 봉인된 버전이 없습니다(gate_id={gate_id}) — 재상신 후 다시 승인받아야 합니다")


class SitePostApproverRoleMissingError(Exception):
    """story #3365(Phase0 S2, 페드루 PO 리뷰) — 조직에 기본 결재 역할(ParticipationRole.
    is_default)이 없으면 상신을 명시적으로 거부한다. 예전엔 `uuid.uuid4()`로 존재하지 않는
    role_id를 만들어 게이트를 생성했다(조용한 폴백 — green을 만드는 자리)."""

    def __init__(self, *, org_id: uuid.UUID):
        self.org_id = org_id
        super().__init__(
            f"조직에 기본 결재 역할이 설정되지 않았습니다(org_id={org_id}) — "
            "조직 설정에서 기본 역할을 지정한 뒤 다시 상신하세요"
        )


class SitePostDraftNotFoundError(Exception):
    def __init__(self, draft_id: uuid.UUID):
        self.draft_id = draft_id
        super().__init__(f"draft를 찾을 수 없습니다: {draft_id}")


class SitePostVersionNotFoundError(Exception):
    def __init__(self, version_id: uuid.UUID | None):
        self.version_id = version_id
        super().__init__(f"버전을 찾을 수 없습니다: {version_id}")


def _validate_slug(slug: str) -> None:
    if not _SLUG_RE.match(slug):
        raise InvalidSitePostInputError(f"slug 형식이 올바르지 않습니다: {slug!r}")


def _validate_lang(lang: str) -> None:
    if not _LANG_RE.match(lang):
        raise InvalidSitePostInputError(f"lang 형식이 올바르지 않습니다: {lang!r}")


async def _resolve_approved_gate(
    db: AsyncSession, *, org_id: uuid.UUID, work_item_id: uuid.UUID, gate_id: uuid.UUID | None,
) -> Gate:
    """gate_id가 주어지면 그 게이트 자체를 검증(work_item/타입 일치 + 승인 상태). 없으면 이
    work item의 external_publish 게이트를 찾아 검증(가장 최근 것 — story #2150 재제출 리셋
    관례상 같은 (work_item, gate_type)엔 사실상 행 1개만 산다)."""
    if gate_id is not None:
        gate = (await db.execute(
            select(Gate).where(Gate.id == gate_id, Gate.org_id == org_id)
        )).scalar_one_or_none()
        if (
            gate is None
            or gate.work_item_id != work_item_id
            or gate.gate_type != "external_publish"
            or gate.status not in _APPROVED_STATUSES
        ):
            raise ExternalPublishGateNotApprovedError(
                gate_id=gate_id, status=gate.status if gate is not None else None,
            )
        return gate

    gate = (await db.execute(
        select(Gate)
        .where(
            Gate.org_id == org_id, Gate.work_item_id == work_item_id, Gate.gate_type == "external_publish",
        )
        .order_by(Gate.created_at.desc())
        .limit(1)
    )).scalar_one_or_none()
    if gate is None or gate.status not in _APPROVED_STATUSES:
        raise ExternalPublishGateNotApprovedError(
            gate_id=gate.id if gate is not None else None, status=gate.status if gate is not None else None,
        )
    return gate


async def publish_site_post(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    work_item_id: uuid.UUID,
    gate_id: uuid.UUID | None,
    title: str,
    slug: str,
    lang: str,
    summary: str,
    tags: list,
    body_md: str,
    created_by_member_id: uuid.UUID,
) -> SitePost:
    _validate_slug(slug)
    _validate_lang(lang)
    gate = await _resolve_approved_gate(db, org_id=org_id, work_item_id=work_item_id, gate_id=gate_id)

    # story #3365(Phase0 S2) AC6 — 승인 뒤 본문이 바뀌었으면 공개하지 않는다. fail-closed
    # (페드루 PO 리뷰 2026-09-03 05:59Z) — 봉인 자체가 없는 승인 게이트(제출→봉인 경로를 안
    # 거친 구식/우회 게이트)는 "무엇이 승인됐는지 모른다"는 뜻이라 통과가 아니라 거부한다.
    # 뮤테이션 대상: 이 블록을 제거하면 승인 후 바뀐 본문이 그대로 공개돼 회귀 테스트가
    # 반드시 실패해야 한다.
    if gate.sealed_content_sha256 is None:
        raise SitePostSealMissingError(gate_id=gate.id)
    current_hash = compute_body_sha256(title=title, lang=lang, summary=summary, tags=tags, body_md=body_md)
    if current_hash != gate.sealed_content_sha256:
        raise SitePostReapprovalRequiredError(gate_id=gate.id)

    now = datetime.now(timezone.utc)
    stmt = pg_insert(SitePost).values(
        id=uuid.uuid4(), org_id=org_id, lang=lang, slug=slug, title=title, summary=summary,
        tags=tags, body_md=body_md, published_at=now, source_story_id=work_item_id,
        gate_id=gate.id, created_by_member_id=created_by_member_id, unpublished_at=None,
    )
    stmt = stmt.on_conflict_do_update(
        constraint="uq_site_posts_org_lang_slug",
        set_={
            "title": title, "summary": summary, "tags": tags, "body_md": body_md,
            "published_at": now, "source_story_id": work_item_id, "gate_id": gate.id,
            "unpublished_at": None, "updated_at": now,
            # created_by_member_id는 최초 발행자 그대로 — 재발행이 저자를 안 바꾼다.
        },
    ).returning(SitePost)
    row = (await db.execute(stmt)).scalar_one()
    await db.commit()
    return row


async def get_published_site_post(db: AsyncSession, *, org_id: uuid.UUID, lang: str, slug: str) -> SitePost | None:
    return (await db.execute(
        select(SitePost).where(
            SitePost.org_id == org_id, SitePost.lang == lang, SitePost.slug == slug,
            SitePost.unpublished_at.is_(None),
        )
    )).scalar_one_or_none()


async def list_published_site_posts(db: AsyncSession, *, org_id: uuid.UUID, lang: str) -> list[SitePost]:
    stmt = (
        select(SitePost)
        .where(SitePost.org_id == org_id, SitePost.lang == lang, SitePost.unpublished_at.is_(None))
        .order_by(SitePost.published_at.desc())
    )
    return list((await db.execute(stmt)).scalars().all())


# ─── story #3365(Phase0 S1) — 초안·불변 버전 ────────────────────────────────────

async def is_agent_caller(db: AsyncSession, *, org_id: uuid.UUID, member_id: uuid.UUID) -> bool:
    """이 caller가 이 org의 agent TeamMember인지 — auth.py `_verify_org_membership`의 OrgMember∪
    TeamMember 재확인 축(story f84227b5, PR#3730)과 동형: 클레임(``api_key_id``)을 신뢰하지 않고
    DB의 실제 멤버 타입으로 판정한다(actor_type fail-closed — 클레임 위조·테스트 하네스의 클레임
    누락 둘 다에 안전)."""
    result = await db.execute(
        select(TeamMember.id).where(
            TeamMember.org_id == org_id, TeamMember.id == member_id, TeamMember.type == "agent",
            TeamMember.is_active.is_(True),
        ).limit(1)
    )
    return result.first() is not None


def compute_body_sha256(*, title: str, lang: str, summary: str, tags: list, body_md: str) -> str:
    """canonical payload hash — S2가 승인 대상 버전을 봉인할 때(gate.sealed_content_sha256)
    재사용할 같은 계산(페드루 PO 확定, 문서 62fc03ee §4-3: "content_sha256"이 이 값 그대로)."""
    canonical = json.dumps(
        {"title": title, "lang": lang, "summary": summary, "tags": tags, "body_md": body_md},
        sort_keys=True, ensure_ascii=False, separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# story #3365(Phase0 S2) — Phase 0엔 미디어가 없어(S1) manifest는 항상 빈 배열 → 이 해시는
# 상수. AC1이 "빈 media manifest hash"를 봉인 값으로 명시해서 지어내지 않고 실제로 계산해 둔다.
_EMPTY_MEDIA_MANIFEST_HASH = hashlib.sha256(json.dumps([], separators=(",", ":")).encode("utf-8")).hexdigest()
_SITE_POST_DESTINATION = "hosted_site"


async def create_site_post_draft_version(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    work_item_id: uuid.UUID,
    slug: str,
    lang: str,
    title: str,
    summary: str,
    tags: list,
    body_md: str,
    media_manifest: list,
    author_member_id: uuid.UUID,
    author_kind: str,
) -> SitePostVersion:
    """초안을 (org, work_item, slug)로 upsert하고 새 불변 버전을 추가한다. 기존 버전은 절대
    덮어쓰지 않는다(AC3) — 에이전트 원안·휴먼 개정본이 별도 행으로 남는다(AC6). 공개 `SitePost`
    행은 여기서 절대 만들지 않는다(AC1) — 승인·발행은 별개 게이트·엔드포인트(S2·S3) 몫."""
    _validate_slug(slug)
    _validate_lang(lang)
    if media_manifest:
        raise MediaNotSupportedPhase0Error("Phase 0은 미디어 입력을 지원하지 않습니다")

    draft = (await db.execute(
        select(SitePostDraft)
        .where(
            SitePostDraft.org_id == org_id, SitePostDraft.work_item_id == work_item_id,
            SitePostDraft.slug == slug,
        )
        .with_for_update()
    )).scalar_one_or_none()
    if draft is None:
        draft = SitePostDraft(id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, slug=slug)
        db.add(draft)
        await db.flush()
        next_version = 1
    else:
        next_version = (await db.execute(
            select(func.coalesce(func.max(SitePostVersion.version), 0)).where(
                SitePostVersion.draft_id == draft.id
            )
        )).scalar_one() + 1

    version = SitePostVersion(
        id=uuid.uuid4(), draft_id=draft.id, version=next_version,
        title=title, lang=lang, summary=summary, tags=tags, body_md=body_md,
        body_sha256=compute_body_sha256(title=title, lang=lang, summary=summary, tags=tags, body_md=body_md),
        author_member_id=author_member_id, author_kind=author_kind,
    )
    db.add(version)
    await db.flush()

    # story #3365(Phase0 S2) AC4·AC5, 페드루 PO 재정정(2026-09-03 06:06Z, 앞선 06:03Z 정정을
    # 유나군 코드 대조로 재철회) — 승인 뒤 봉인은 "무엇이 승인됐었나"의 유일한 기록이라 편집
    # 훅이 조용히 덮으면 안 된다(publish_site_post의 409 비교 기준점이 죽는다). 확定 규칙:
    #   · pending 中 편집  → 같은 트랜잭션에서 즉시 재봉인(결재자가 볼 것=승인할 것, 아직
    #     파괴할 승인 기록이 없다).
    #   · approved 뒤 편집 → pending 재오픈 + reapproval_required=True, **봉인은 옛 버전
    #     그대로 유지**(재봉인은 submit_site_post_draft의 명시 재호출만이 한다 — gates.py의
    #     approve 전이가 reapproval_required=True인 동안 409로 막혀 "옛 봉인을 승인하는" 막다른
    #     길 자체를 차단한다).
    await _reseal_gate_on_new_version(db, org_id=org_id, work_item_id=work_item_id, version=version)

    await db.commit()
    await db.refresh(version)
    return version


async def _reseal_gate_on_new_version(
    db: AsyncSession, *, org_id: uuid.UUID, work_item_id: uuid.UUID, version: SitePostVersion,
) -> None:
    gate = (await db.execute(
        select(Gate)
        .where(
            Gate.org_id == org_id, Gate.work_item_id == work_item_id, Gate.gate_type == "external_publish",
            Gate.status.in_(("pending", "approved")),
        )
        .with_for_update()
    )).scalar_one_or_none()
    if gate is None:
        return
    if gate.status == "approved":
        # 승인된 뒤 편집 — pending으로 되돌리기만 한다. sealed_content_*는 절대 안 건드린다
        # (여기서 건드리면 "무엇이 승인됐었나" 기록이 사라진다 — 재봉인은 submit() 재호출 몫).
        set_gate_status(gate, "pending", now=datetime.now(timezone.utc))
        gate.requires_human = True
        gate.resolver_id = None
        gate.resolution_note = None
        gate.resolved_at = None
        gate.reapproval_required = True
        return
    # 아직 한 번도 승인된 적 없는 pending — 결재자가 볼 대상 자체가 그냥 최신본이면 되므로
    # 편집마다 즉시 재봉인(재상신 왕복 불요).
    gate.sealed_content_version = version.version
    gate.sealed_content_sha256 = version.body_sha256
    gate.sealed_content_body = version.body_md


async def get_site_post_draft(db: AsyncSession, *, org_id: uuid.UUID, draft_id: uuid.UUID) -> SitePostDraft | None:
    return (await db.execute(
        select(SitePostDraft).where(SitePostDraft.id == draft_id, SitePostDraft.org_id == org_id)
    )).scalar_one_or_none()


async def list_site_post_draft_versions(db: AsyncSession, *, draft_id: uuid.UUID) -> list[SitePostVersion]:
    stmt = (
        select(SitePostVersion)
        .where(SitePostVersion.draft_id == draft_id)
        .order_by(SitePostVersion.version.asc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def list_site_post_drafts(
    db: AsyncSession, *, org_id: uuid.UUID, limit: int = 50, offset: int = 0,
) -> list[tuple[SitePostDraft, SitePostVersion, SitePostVersion]]:
    """story #3365 후속(S4 계약 갭, 페드루 PO 확定 2026-09-03) — 조직 스코프 초안 목록. S4
    화면이 열릴 때 draft_id를 미리 알 방법이 없어 만든 자리 — 항목마다 최신 버전(title·lang·
    version·author_kind)과 원안 버전(version 1, origin_author_kind — «에이전트가 쓰고 사람이
    고친 글» vs «사람이 쓴 글» 구별용, 페드루 PO 후속 2026-09-03 05:33Z)을 붙인다. "최신"은
    draft.updated_at이 아니라 최신 버전의 created_at으로 정렬한다 — draft 행 자체는 버전 추가
    시 갱신되지 않아(SSOT는 버전 쪽) 이 값이 실제 최근 활동을 반영한다. 게이트 상태·봉인
    필드는 여기서 지어내지 않는다(라우터가 별도로 필요하면 gate를 따로 조회).

    반환: (draft, latest_version, origin_version) 튜플 리스트."""
    latest_version_ids = (
        select(
            SitePostVersion.draft_id,
            func.max(SitePostVersion.version).label("max_version"),
        )
        .group_by(SitePostVersion.draft_id)
        .subquery()
    )
    origin_version_ids = (
        select(
            SitePostVersion.draft_id,
            func.min(SitePostVersion.version).label("min_version"),
        )
        .group_by(SitePostVersion.draft_id)
        .subquery()
    )
    latest = aliased(SitePostVersion)
    origin = aliased(SitePostVersion)
    stmt = (
        select(SitePostDraft, latest, origin)
        .join(latest_version_ids, latest_version_ids.c.draft_id == SitePostDraft.id)
        .join(
            latest,
            (latest.draft_id == latest_version_ids.c.draft_id)
            & (latest.version == latest_version_ids.c.max_version),
        )
        .join(origin_version_ids, origin_version_ids.c.draft_id == SitePostDraft.id)
        .join(
            origin,
            (origin.draft_id == origin_version_ids.c.draft_id)
            & (origin.version == origin_version_ids.c.min_version),
        )
        .where(SitePostDraft.org_id == org_id)
        .order_by(latest.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return [(row[0], row[1], row[2]) for row in (await db.execute(stmt)).all()]


async def submit_site_post_draft(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    draft_id: uuid.UUID,
    version_id: uuid.UUID | None,
    requester_member_id: uuid.UUID,
) -> tuple[Gate, uuid.UUID]:
    """story #3365(Phase0 S2) — 초안 버전을 external_publish 게이트에 상신. 대상 버전(생략 시
    최신)의 content_sha256·content_version·본문 스냅샷을 게이트에 봉인(sealed_content_*)한다.

    페드루 PO 정정(2026-09-03 06:03Z) — 봉인은 "승인된 뒤"에만 불변이다. pending/approved인
    한 `_reseal_gate_on_new_version`(버전 생성 훅)이 매 편집마다 이미 최신 버전으로 계속
    동기화해 두므로, 이 함수는 대부분 그 동기화된 상태를 그대로 반환하는 idempotent 조회다
    (아래 sha 동일성 분기). 값이 다를 때만(예: 명시적으로 과거 버전을 상신 요청) 여기서
    직접 재봉인한다 — 그것도 submit() 호출 자체가 그 재봉인의 명시적 트리거다.

    에이전트 키도 호출 가능(AC2) — external_publish는 `_ALWAYS_MANUAL_GATE_TYPES`라 create_gate가
    호출자 무관 항상 pending을 강제한다(gate_service.py 참고, 신규 코드 불요)."""
    draft = await get_site_post_draft(db, org_id=org_id, draft_id=draft_id)
    if draft is None:
        raise SitePostDraftNotFoundError(draft_id)

    versions = await list_site_post_draft_versions(db, draft_id=draft_id)
    if not versions:
        raise SitePostDraftNotFoundError(draft_id)
    target = versions[-1] if version_id is None else next((v for v in versions if v.id == version_id), None)
    if target is None:
        raise SitePostVersionNotFoundError(version_id)
    origin_author_member_id = versions[0].author_member_id

    from app.services.gate_service import create_gate, find_gate_slot_with_pr_fallback
    from app.services.workflow_line_config import _default_role_id

    existing = await find_gate_slot_with_pr_fallback(
        db, org_id=org_id, work_item_id=draft.work_item_id, work_item_type="story",
        gate_type="external_publish", pr_number=None, repo_full_name=None,
    )
    if (
        existing is not None
        and existing.sealed_content_sha256 == target.body_sha256
        and existing.status in ("pending", "approved")
    ):
        return existing, target.id  # 이미 이 정확한 내용으로 봉인돼 있다 — 재봉인하지 않는다(불변).

    neutral_facts = {
        "destination": _SITE_POST_DESTINATION,
        "media_manifest_hash": _EMPTY_MEDIA_MANIFEST_HASH,
        "draft_author_member_id": str(origin_author_member_id),
        "requested_by_member_id": str(requester_member_id),
    }

    # 페드루 PO 리뷰(2026-09-03 05:59Z) — 기본 역할이 없으면 가짜 uuid로 게이트를 만드는
    # 조용한 폴백 대신 명시 실패한다(SITE_POST_APPROVER_ROLE_MISSING).
    role_id = await _default_role_id(db, org_id)
    if role_id is None:
        raise SitePostApproverRoleMissingError(org_id=org_id)
    gate = await create_gate(
        db, org_id, draft.work_item_id, "story", "external_publish",
        requester_member_id, role_id, neutral_facts=neutral_facts,
    )
    # create_gate()의 기존-pending/approved 멱등 반환 분기는 neutral_facts 인자를 무시한다
    # (신규 생성·rejected 재오픈 경로에서만 반영) — 위 sha 동일성 조기 return을 안 탔다는 건
    # 내용이 달라졌거나 신규라는 뜻이라, 여기서 명시적으로 (재)봉인하는 것이 바로 이번
    # submit() 호출이 의도한 행위다("조용한 갱신"이 아니다).
    gate.neutral_facts = neutral_facts
    if gate.status != "pending":
        set_gate_status(gate, "pending", now=datetime.now(timezone.utc))
        gate.requires_human = True
        gate.resolver_id = None
        gate.resolution_note = None
        gate.resolved_at = None
    gate.sealed_content_version = target.version
    gate.sealed_content_sha256 = target.body_sha256
    gate.sealed_content_body = target.body_md
    gate.reapproval_required = False
    await db.commit()
    await db.refresh(gate)
    return gate, target.id
