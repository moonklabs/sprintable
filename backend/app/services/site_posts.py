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

from app.models.gate import Gate
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
    """canonical payload hash — S2가 승인 대상 버전을 봉인할 때(gate neutral_facts) 재사용할
    같은 계산(페드루 PO 확定, 문서 62fc03ee §4-3: "content_sha256"이 이 값 그대로)."""
    canonical = json.dumps(
        {"title": title, "lang": lang, "summary": summary, "tags": tags, "body_md": body_md},
        sort_keys=True, ensure_ascii=False, separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


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
    await db.commit()
    await db.refresh(version)
    return version


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
) -> list[tuple[SitePostDraft, SitePostVersion]]:
    """story #3365 후속(S4 계약 갭, 페드루 PO 확定 2026-09-03) — 조직 스코프 초안 목록. S4
    화면이 열릴 때 draft_id를 미리 알 방법이 없어 만든 자리 — 항목마다 최신 버전(title·lang·
    version·author_kind)을 붙인다. "최신"은 draft.updated_at이 아니라 최신 버전의
    created_at으로 정렬한다 — draft 행 자체는 버전 추가 시 갱신되지 않아(SSOT는 버전 쪽)
    이 값이 실제 최근 활동을 반영한다. 게이트 상태·봉인 필드는 S2 몫 — 여기서 지어내지 않는다."""
    latest_version_ids = (
        select(
            SitePostVersion.draft_id,
            func.max(SitePostVersion.version).label("max_version"),
        )
        .group_by(SitePostVersion.draft_id)
        .subquery()
    )
    latest = aliased(SitePostVersion)
    stmt = (
        select(SitePostDraft, latest)
        .join(latest_version_ids, latest_version_ids.c.draft_id == SitePostDraft.id)
        .join(
            latest,
            (latest.draft_id == latest_version_ids.c.draft_id)
            & (latest.version == latest_version_ids.c.max_version),
        )
        .where(SitePostDraft.org_id == org_id)
        .order_by(latest.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return [(row[0], row[1]) for row in (await db.execute(stmt)).all()]
